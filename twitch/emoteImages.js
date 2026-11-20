// Resolves emote NAMES to image URLs, so stats pages can render the actual emote instead of
// its text signature. The bot's whiteList/WordLifetimeStats rows carry only {channel, word} -
// no ids, no images - so the join happens here, against the three sources the bot syncs from:
//
//   - Twitch's official global emotes (Helix "Get Global Emotes", app token, no user scope)
//   - the broadcaster's own Twitch emotes (Helix "Get Channel Emotes", sub tiers/bits/follower)
//   - the channel's 7TV emote set, auto-resolved from its Twitch broadcaster ID
//     (GET https://7tv.io/v3/users/twitch/{broadcasterId} - no manual link/config anymore,
//     same resolution the bot's sevenTv/SevenTvEmotes.js does, duplicated here since the repos
//     don't share code)
//
// All three are fetched lazily and cached in memory: the Twitch global list is identical for
// every channel and changes rarely (hours-long TTL), the channel/7TV sources are per-channel
// and owner-editable (short TTL so a newly added emote shows up without a restart).
//
// A page never waits for a provider whose list it already holds. An expired entry is served as
// it is and refreshed in the background, one fetch per source at a time; only a source never
// fetched since boot is waited for, and then for at most COLD_WAIT_MS - past that the page renders
// without those pictures and a later view gets them. Measured from the VPS, FFZ's /set/global took
// 21s when it answered at all (two of three probes hit a 30s ceiling) and 7TV answers in 1-2s,
// while a page's own Mongo work is tens of ms: with refresh-on-expiry every page that draws emotes
// ran at the speed of the slowest provider once per TTL, and that was most of the slow-requests
// log. Everything here is fail-soft - an unreachable 7TV/Helix just means fewer resolved images, never a 500:
// an emote with no image (e.g. removed from the set since it was counted) falls back to text
// in the view.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");
const channelsRepo = require("../db/channelsRepo");
const emoteRegistryRepo = require("../db/emoteRegistryRepo");
const {
  isAllowedImageUrl,
  twitchEmoteUrl,
  sevenTvEmoteUrl,
  bttvEmoteUrl,
} = require("../lib/emoteImageHosts");

const GLOBAL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes/global";
const CHANNEL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes";
const SEVEN_TV_API = "https://7tv.io/v3";
const BTTV_API = "https://api.betterttv.net/3";
const FFZ_API = "https://api.frankerfacez.com/v1";
// CDN url builders live in lib/emoteImageHosts.js, next to the CSP img-src list they must match.

const GLOBAL_TTL_MS = 12 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 10 * 60 * 1000;
const SEVEN_TV_TTL_MS = 10 * 60 * 1000;
// A background fetch still holds its source's single-flight slot; without a ceiling one hung
// provider call would keep that source from ever refreshing again.
const FETCH_TIMEOUT_MS = 15_000;
// How long a page waits for a source it has never had. Kept under the slow-request threshold.
const COLD_WAIT_MS = 700;
// After a failed fetch the source is not retried on every page view.
const RETRY_AFTER_FAILURE_MS = 60_000;

const http = axios.create({ timeout: FETCH_TIMEOUT_MS });
// FFZ builds a room's answer on demand and caches it: measured 2026-11-20, the first request for
// #mistercop took 21.8s and the next ones 0.19s. Under the process-wide 15s timeout the cold
// request was aborted every time, so the picture fetch failed on every attempt. Nobody waits on this call
// (the result is cached), so it gets room for the cold build.
const ROOM_TIMEOUT_MS = 45_000;

const globalCache = {};
// One memo per source; the ones identical for every channel keep theirs on `.value` (see
// cachedMap), the per-channel ones key by broadcaster id - or by login, for the only source
// that is a row of ours rather than a provider's list.
const sevenTvGlobalCache = {};
const bttvGlobalCache = {};
const ffzGlobalCache = {};
const bttvChannelCache = new Map(); // broadcasterId -> { map, expiresAt }
const ffzChannelCache = new Map(); // broadcasterId -> { map, expiresAt }
const externalEmoteCache = new Map(); // channelLogin -> { map, expiresAt }
const channelEmoteCache = new Map(); // broadcasterId -> { map, expiresAt }
const sevenTvCache = new Map(); // broadcasterId -> { value, expiresAt } - raw 7TV response, null if not linked

async function fetchGlobalEmoteImages() {
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const { data } = await http.get(GLOBAL_EMOTES_URL, { headers });
  const map = new Map();
  for (const emote of data.data || []) {
    // Helix ships duplicate names for the classic text emoticons (":)", "<3", ...) under
    // different ids - first one wins, same dedupe the bot's globalEmotes.js does.
    if (!map.has(emote.name)) {
      map.set(emote.name, emote.images?.url_2x || emote.images?.url_1x || null);
    }
  }
  return map;
}

async function fetchChannelEmoteImages(broadcasterId) {
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const { data } = await http.get(CHANNEL_EMOTES_URL, {
    params: { broadcaster_id: broadcasterId },
    headers,
  });
  const map = new Map();
  for (const emote of data.data || []) {
    if (!map.has(emote.name)) {
      map.set(emote.name, emote.images?.url_2x || emote.images?.url_1x || null);
    }
  }
  return map;
}

// Raw 7TV user-connection response for this broadcaster, or null if they have no 7TV account
// linked to Twitch (404). Cached because both the emote-image map and the settings-page
// linked/not-linked status need the same fetch.
async function fetchSevenTvUser(broadcasterId) {
  try {
    const { data } = await http.get(`${SEVEN_TV_API}/users/twitch/${broadcasterId}`);
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

function getGlobalEmoteImages(opts) {
  return cached(globalCache, null, GLOBAL_TTL_MS, fetchGlobalEmoteImages, "Twitch global emotes", new Map(), opts);
}

function getChannelEmoteImages(broadcasterId, opts) {
  if (!broadcasterId) return Promise.resolve(new Map());
  return cached(
    channelEmoteCache,
    broadcasterId,
    CHANNEL_TTL_MS,
    () => fetchChannelEmoteImages(broadcasterId),
    "Twitch channel emotes",
    new Map(),
    opts
  );
}

function getSevenTvUser(broadcasterId, opts) {
  if (!broadcasterId) return Promise.resolve(null);
  return cached(sevenTvCache, broadcasterId, SEVEN_TV_TTL_MS, () => fetchSevenTvUser(broadcasterId), "7TV lookup", null, opts);
}

async function getSevenTvEmoteImages(broadcasterId, opts) {
  const user = await getSevenTvUser(broadcasterId, opts);
  const map = new Map();
  for (const emote of user?.emote_set?.emotes ?? []) {
    // Set-local name (the alias actually typed in chat), matching what the bot whitelists.
    map.set(emote.name, sevenTvEmoteUrl(emote.id));
  }
  return map;
}

// Whether this broadcaster has a 7TV account linked to their Twitch, and how many emotes it
// carries - for the settings page's read-only status line (no more manual link field). Waits for a
// cold source: "not linked" is a statement on that page, not a missing picture.
async function getSevenTvLinkStatus(broadcasterId) {
  const user = await getSevenTvUser(broadcasterId, { complete: true });
  return { linked: !!user?.emote_set, emoteCount: user?.emote_set?.emotes?.length ?? 0 };
}

// ---------------------------------------------------------------------------------------
// The three browser-extension providers, plus the emotes the bot learnt off the wire.
//
// Every name in the channel's whitelist has to resolve to a picture here or it renders as bare
// text, so this file has to read the same set of sources the bot syncs from - see that chain in
// TwitchBot/twitch/emoteSyncScheduler.js. Same fail-soft rule as the sources above: an
// unreachable provider costs pictures, never a 500.
// ---------------------------------------------------------------------------------------

async function fetchSevenTvGlobalImages() {
  const { data } = await http.get(`${SEVEN_TV_API}/emote-sets/global`);
  const map = new Map();
  for (const emote of data?.emotes ?? []) {
    if (emote.name) map.set(emote.name, sevenTvEmoteUrl(emote.id));
  }
  return map;
}

async function fetchBttvGlobalImages() {
  const { data } = await http.get(`${BTTV_API}/cached/emotes/global`);
  return new Map((data ?? []).filter((e) => e.code).map((e) => [e.code, bttvEmoteUrl(e.id)]));
}

// 404 = this broadcaster has never opened BTTV. That is "no emotes", not an error, and must not
// be logged as one - most channels are in exactly that state.
async function fetchBttvChannelImages(broadcasterId) {
  try {
    const { data } = await http.get(`${BTTV_API}/cached/users/twitch/${broadcasterId}`);
    const emotes = [...(data?.channelEmotes ?? []), ...(data?.sharedEmotes ?? [])];
    return new Map(emotes.filter((e) => e.code).map((e) => [e.code, bttvEmoteUrl(e.id)]));
  } catch (err) {
    if (err.response?.status === 404) return new Map();
    throw err;
  }
}

// FFZ hands out its own CDN urls per size, so they are used as given rather than built - the
// path shape is not part of any contract. Only the sets FFZ marks enabled render for a viewer,
// which is the same filter the bot's ffz/FfzEmotes.js applies when it whitelists the names.
function ffzImagesFromSets(data, onlyDefaultSets) {
  const sets = data?.sets ?? {};
  const ids = onlyDefaultSets && Array.isArray(data?.default_sets) && data.default_sets.length > 0
    ? data.default_sets.map(String)
    : Object.keys(sets);
  const map = new Map();
  for (const id of ids) {
    for (const emote of sets[id]?.emoticons ?? []) {
      const url = emote.urls?.["2"] ?? emote.urls?.["1"] ?? null;
      if (emote.name && url) map.set(emote.name, url.startsWith("//") ? `https:${url}` : url);
    }
  }
  return map;
}

async function fetchFfzGlobalImages() {
  const { data } = await http.get(`${FFZ_API}/set/global`);
  return ffzImagesFromSets(data, true);
}

async function fetchFfzChannelImages(broadcasterId) {
  try {
    const { data } = await http.get(`${FFZ_API}/room/id/${broadcasterId}`, { timeout: ROOM_TIMEOUT_MS });
    return ffzImagesFromSets(data, false);
  } catch (err) {
    if (err.response?.status === 404) return new Map();
    throw err;
  }
}

// Twitch emotes of OTHER broadcasters, learnt by the bot from the IRC `emotes` tag. The only
// source here that is a database read rather than a provider fetch, and the only one keyed by
// channel login rather than broadcaster id - see db/emoteRegistryRepo.js for why the picture's
// id has to come from our own row.
async function fetchExternalEmoteImages(channelLogin) {
  const rows = await emoteRegistryRepo.listExternalEmotes(channelLogin);
  return new Map(rows.map((row) => [row.word, twitchEmoteUrl(row.emoteId)]));
}

// One memo per source, so a slow or broken provider is retried on its own schedule instead of
// taking the others' cached maps down with it. `key` is null for the sources that are identical
// for every channel (fetched once and shared).
//
// Entry: { value, expiresAt, refreshing } - `refreshing` is the one in-flight fetch, shared by
// everyone who asks meanwhile. Fresh: returned. Expired: returned anyway, refresh started. Never
// fetched: waited for up to COLD_WAIT_MS, else `empty`. `opts.complete` lifts that ceiling on the
// never-fetched case, for callers that keep or state the result rather than draw it (the recap
// job, the 7TV link status) - a list ten minutes old is still the right answer for them. A failed fetch keeps the previous value and holds off retries for
// RETRY_AFTER_FAILURE_MS.
function cached(store, key, ttlMs, fetcher, label, empty, opts = {}) {
  let entry = key === null ? store.value : store.get(key);
  if (!entry) {
    entry = { value: undefined, expiresAt: 0, refreshing: null };
    if (key === null) store.value = entry;
    else store.set(key, entry);
  }
  const has = entry.value !== undefined;
  if (has && Date.now() < entry.expiresAt) return Promise.resolve(entry.value);

  if (!entry.refreshing) {
    entry.refreshing = Promise.resolve()
      .then(fetcher)
      .then(
        (value) => {
          entry.value = value;
          entry.expiresAt = Date.now() + ttlMs;
        },
        (err) => {
          console.error(`[emoteImages] ${label} fetch failed:`, err.message);
          // A source down since boot must not make every page sit out COLD_WAIT_MS until it
          // recovers: "nothing" becomes its cached value, refreshed like any other.
          if (entry.value === undefined) entry.value = empty;
          entry.expiresAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        }
      )
      .finally(() => {
        entry.refreshing = null;
      });
  }
  const current = () => (entry.value !== undefined ? entry.value : empty);
  if (has) return Promise.resolve(entry.value);
  if (opts.complete) return entry.refreshing.then(current);
  let timer;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(resolve, COLD_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([entry.refreshing, giveUp]).then(() => {
    clearTimeout(timer);
    return current();
  });
}

// name -> image URL for everything resolvable for this channel. Precedence on a name collision
// matches the bot's whitelist sync order exactly (TwitchBot/twitch/emoteSyncScheduler.js:
// Twitch global -> Twitch channel -> 7TV global -> BTTV -> FFZ -> the channel's own 7TV set,
// last wins), because that order is what decided which set owns the whitelist row in the first
// place.
//
// The Twitch emotes of OTHER broadcasters go first, i.e. lowest: the bot only ever inserts those
// rows and never updates them, so a name that also belongs to a set this channel really has
// should show that set's picture.
//
// `channelLogin` is optional only so a caller holding nothing but a broadcaster id still works -
// it costs that caller the learnt emotes, which are keyed by login.
//
// `opts.complete` waits for every source instead of answering with what is cached (see cached()).
// A page leaves it off; a job whose result is stored passes it.
async function getEmoteImageMap(broadcasterId, channelLogin, opts) {
  const [external, global, channel, sevenTvGlobal, bttv, ffz, sevenTv] = await Promise.all([
    getExternalEmoteImages(channelLogin, opts),
    getGlobalEmoteImages(opts),
    getChannelEmoteImages(broadcasterId, opts),
    getSevenTvGlobalImages(opts),
    getBttvEmoteImages(broadcasterId, opts),
    getFfzEmoteImages(broadcasterId, opts),
    getSevenTvEmoteImages(broadcasterId, opts),
  ]);
  const merged = new Map([...external, ...global, ...channel, ...sevenTvGlobal, ...bttv, ...ffz, ...sevenTv]);
  return dropBlockedImages(merged);
}

// The page's CSP decides which of these pictures a browser will actually fetch, and a refused one
// renders as a zero-width broken image - worse than the text an unresolved emote falls back to.
// So a URL whose origin the CSP doesn't allow is treated as "no picture": the name stays out of
// the map and every caller (clouds, chat text, comments) draws it as text. Logged once per origin,
// because the only other trace of this is in a viewer's browser console.
const reportedBlockedOrigins = new Set();
function dropBlockedImages(map) {
  for (const [name, url] of map) {
    if (isAllowedImageUrl(url)) continue;
    map.delete(name);
    let origin = String(url);
    try { origin = new URL(url).origin; } catch { /* keep the raw value */ }
    if (!reportedBlockedOrigins.has(origin)) {
      reportedBlockedOrigins.add(origin);
      console.warn(`[emoteImages] dropping emote images from ${origin}: not in the CSP img-src list (lib/emoteImageHosts.js)`);
    }
  }
  return map;
}

function getSevenTvGlobalImages(opts) {
  return cached(sevenTvGlobalCache, null, GLOBAL_TTL_MS, fetchSevenTvGlobalImages, "7TV global emotes", new Map(), opts);
}

// Channel and global merged per provider, mirroring the single whitelist source the bot writes
// them to: both halves render in this chat, and nothing downstream tells them apart.
async function getBttvEmoteImages(broadcasterId, opts) {
  const [global, channel] = await Promise.all([
    cached(bttvGlobalCache, null, GLOBAL_TTL_MS, fetchBttvGlobalImages, "BTTV global emotes", new Map(), opts),
    broadcasterId
      ? cached(bttvChannelCache, broadcasterId, CHANNEL_TTL_MS, () => fetchBttvChannelImages(broadcasterId), "BTTV channel emotes", new Map(), opts)
      : new Map(),
  ]);
  return new Map([...global, ...channel]);
}

async function getFfzEmoteImages(broadcasterId, opts) {
  const [global, channel] = await Promise.all([
    cached(ffzGlobalCache, null, GLOBAL_TTL_MS, fetchFfzGlobalImages, "FFZ global emotes", new Map(), opts),
    broadcasterId
      ? cached(ffzChannelCache, broadcasterId, CHANNEL_TTL_MS, () => fetchFfzChannelImages(broadcasterId), "FFZ channel emotes", new Map(), opts)
      : new Map(),
  ]);
  return new Map([...global, ...channel]);
}

function getExternalEmoteImages(channelLogin, opts) {
  if (!channelLogin) return Promise.resolve(new Map());
  return cached(
    externalEmoteCache,
    String(channelLogin).toLowerCase(),
    CHANNEL_TTL_MS,
    () => fetchExternalEmoteImages(channelLogin),
    "learnt Twitch emotes",
    new Map(),
    opts
  );
}

// Join emote usage counts (text names) to real images from the channel's own Twitch emotes,
// its 7TV set, and Twitch's global emotes. An emote that resolves to no image (e.g. removed
// from the set since it was counted) keeps imageUrl: null so the UI can fall back to its text
// form instead of dropping it. Returns a NEW array - callers pass repo results that may be
// cached, never mutate them.
async function withEmoteImages(channelLogin, emotes) {
  const channelDoc = await channelsRepo.findByLogin(channelLogin);
  const imageMap = await getEmoteImageMap(channelDoc?.channelId, channelLogin);
  return emotes.map((e) => ({ ...e, imageUrl: imageMap.get(e.word) ?? null }));
}

module.exports = {
  getEmoteImageMap,
  getSevenTvGlobalImages,
  getBttvEmoteImages,
  getFfzEmoteImages,
  getGlobalEmoteImages,
  getChannelEmoteImages,
  getSevenTvEmoteImages,
  getSevenTvLinkStatus,
  withEmoteImages,
};
