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
// and owner-editable (short TTL so a newly added emote shows up without a restart). Everything
// here is fail-soft - an unreachable 7TV/Helix just means fewer resolved images, never a 500:
// an emote with no image (e.g. removed from the set since it was counted) falls back to text
// in the view.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");
const channelsRepo = require("../db/channelsRepo");
const emoteRegistryRepo = require("../db/emoteRegistryRepo");

const GLOBAL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes/global";
const CHANNEL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes";
const SEVEN_TV_API = "https://7tv.io/v3";
const BTTV_API = "https://api.betterttv.net/3";
const FFZ_API = "https://api.frankerfacez.com/v1";
// Twitch's emote CDN. `default` serves the animated file when the emote has one; the theme
// only decides which background the transparent edges were baked against.
const TWITCH_EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";
const bttvUrl = (id) => `https://cdn.betterttv.net/emote/${id}/2x.webp`;

const GLOBAL_TTL_MS = 12 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 10 * 60 * 1000;
const SEVEN_TV_TTL_MS = 10 * 60 * 1000;

let globalCache = null; // { map, expiresAt }
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
const sevenTvCache = new Map(); // broadcasterId -> { data, expiresAt } - raw 7TV response, null if not linked

async function fetchGlobalEmoteImages() {
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const { data } = await axios.get(GLOBAL_EMOTES_URL, { headers });
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
  const { data } = await axios.get(CHANNEL_EMOTES_URL, {
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
    const { data } = await axios.get(`${SEVEN_TV_API}/users/twitch/${broadcasterId}`);
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getGlobalEmoteImages() {
  if (globalCache && Date.now() < globalCache.expiresAt) return globalCache.map;
  try {
    const map = await fetchGlobalEmoteImages();
    globalCache = { map, expiresAt: Date.now() + GLOBAL_TTL_MS };
    return map;
  } catch (err) {
    console.error("[emoteImages] Twitch global emotes fetch failed:", err.message);
    return globalCache?.map ?? new Map();
  }
}

async function getChannelEmoteImages(broadcasterId) {
  if (!broadcasterId) return new Map();
  const cached = channelEmoteCache.get(broadcasterId);
  if (cached && Date.now() < cached.expiresAt) return cached.map;
  try {
    const map = await fetchChannelEmoteImages(broadcasterId);
    channelEmoteCache.set(broadcasterId, { map, expiresAt: Date.now() + CHANNEL_TTL_MS });
    return map;
  } catch (err) {
    console.error("[emoteImages] Twitch channel emotes fetch failed:", err.message);
    return cached?.map ?? new Map();
  }
}

async function getSevenTvUser(broadcasterId) {
  if (!broadcasterId) return null;
  const cached = sevenTvCache.get(broadcasterId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  try {
    const data = await fetchSevenTvUser(broadcasterId);
    sevenTvCache.set(broadcasterId, { data, expiresAt: Date.now() + SEVEN_TV_TTL_MS });
    return data;
  } catch (err) {
    console.error("[emoteImages] 7TV lookup failed:", err.message);
    return cached?.data ?? null;
  }
}

async function getSevenTvEmoteImages(broadcasterId) {
  const user = await getSevenTvUser(broadcasterId);
  const map = new Map();
  for (const emote of user?.emote_set?.emotes ?? []) {
    // Set-local name (the alias actually typed in chat), matching what the bot whitelists.
    map.set(emote.name, `https://cdn.7tv.app/emote/${emote.id}/2x.webp`);
  }
  return map;
}

// Whether this broadcaster has a 7TV account linked to their Twitch, and how many emotes it
// carries - for the settings page's read-only status line (no more manual link field).
async function getSevenTvLinkStatus(broadcasterId) {
  const user = await getSevenTvUser(broadcasterId);
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
  const { data } = await axios.get(`${SEVEN_TV_API}/emote-sets/global`);
  const map = new Map();
  for (const emote of data?.emotes ?? []) {
    if (emote.name) map.set(emote.name, `https://cdn.7tv.app/emote/${emote.id}/2x.webp`);
  }
  return map;
}

async function fetchBttvGlobalImages() {
  const { data } = await axios.get(`${BTTV_API}/cached/emotes/global`);
  return new Map((data ?? []).filter((e) => e.code).map((e) => [e.code, bttvUrl(e.id)]));
}

// 404 = this broadcaster has never opened BTTV. That is "no emotes", not an error, and must not
// be logged as one - most channels are in exactly that state.
async function fetchBttvChannelImages(broadcasterId) {
  try {
    const { data } = await axios.get(`${BTTV_API}/cached/users/twitch/${broadcasterId}`);
    const emotes = [...(data?.channelEmotes ?? []), ...(data?.sharedEmotes ?? [])];
    return new Map(emotes.filter((e) => e.code).map((e) => [e.code, bttvUrl(e.id)]));
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
  const { data } = await axios.get(`${FFZ_API}/set/global`);
  return ffzImagesFromSets(data, true);
}

async function fetchFfzChannelImages(broadcasterId) {
  try {
    const { data } = await axios.get(`${FFZ_API}/room/id/${broadcasterId}`);
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
  return new Map(rows.map((row) => [row.word, `${TWITCH_EMOTE_CDN}/${row.emoteId}/default/dark/2.0`]));
}

// One memo per source, so a slow or broken provider is retried on its own schedule instead of
// taking the others' cached maps down with it. `key` is null for the sources that are identical
// for every channel (fetched once and shared).
async function cachedMap(store, key, ttlMs, fetcher, label) {
  const cached = key === null ? store.value : store.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.map;
  try {
    const map = await fetcher();
    const entry = { map, expiresAt: Date.now() + ttlMs };
    if (key === null) store.value = entry;
    else store.set(key, entry);
    return map;
  } catch (err) {
    console.error(`[emoteImages] ${label} fetch failed:`, err.message);
    return cached?.map ?? new Map();
  }
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
async function getEmoteImageMap(broadcasterId, channelLogin) {
  const [external, global, channel, sevenTvGlobal, bttv, ffz, sevenTv] = await Promise.all([
    getExternalEmoteImages(channelLogin),
    getGlobalEmoteImages(),
    getChannelEmoteImages(broadcasterId),
    getSevenTvGlobalImages(),
    getBttvEmoteImages(broadcasterId),
    getFfzEmoteImages(broadcasterId),
    getSevenTvEmoteImages(broadcasterId),
  ]);
  return new Map([...external, ...global, ...channel, ...sevenTvGlobal, ...bttv, ...ffz, ...sevenTv]);
}

function getSevenTvGlobalImages() {
  return cachedMap(sevenTvGlobalCache, null, GLOBAL_TTL_MS, fetchSevenTvGlobalImages, "7TV global emotes");
}

// Channel and global merged per provider, mirroring the single whitelist source the bot writes
// them to: both halves render in this chat, and nothing downstream tells them apart.
async function getBttvEmoteImages(broadcasterId) {
  const [global, channel] = await Promise.all([
    cachedMap(bttvGlobalCache, null, GLOBAL_TTL_MS, fetchBttvGlobalImages, "BTTV global emotes"),
    broadcasterId
      ? cachedMap(bttvChannelCache, broadcasterId, CHANNEL_TTL_MS, () => fetchBttvChannelImages(broadcasterId), "BTTV channel emotes")
      : new Map(),
  ]);
  return new Map([...global, ...channel]);
}

async function getFfzEmoteImages(broadcasterId) {
  const [global, channel] = await Promise.all([
    cachedMap(ffzGlobalCache, null, GLOBAL_TTL_MS, fetchFfzGlobalImages, "FFZ global emotes"),
    broadcasterId
      ? cachedMap(ffzChannelCache, broadcasterId, CHANNEL_TTL_MS, () => fetchFfzChannelImages(broadcasterId), "FFZ channel emotes")
      : new Map(),
  ]);
  return new Map([...global, ...channel]);
}

function getExternalEmoteImages(channelLogin) {
  if (!channelLogin) return Promise.resolve(new Map());
  return cachedMap(
    externalEmoteCache,
    String(channelLogin).toLowerCase(),
    CHANNEL_TTL_MS,
    () => fetchExternalEmoteImages(channelLogin),
    "learnt Twitch emotes"
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
