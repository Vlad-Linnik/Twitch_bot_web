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

const GLOBAL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes/global";
const CHANNEL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes";
const SEVEN_TV_API = "https://7tv.io/v3";

const GLOBAL_TTL_MS = 12 * 60 * 60 * 1000;
const CHANNEL_TTL_MS = 10 * 60 * 1000;
const SEVEN_TV_TTL_MS = 10 * 60 * 1000;

let globalCache = null; // { map, expiresAt }
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

// name -> image URL for everything resolvable for this channel. Precedence on a name collision
// matches the bot's whitelist sync order (global -> channel -> 7TV, last wins): a 7TV emote is
// the most deliberately curated of the three.
async function getEmoteImageMap(broadcasterId) {
  const [global, channel, sevenTv] = await Promise.all([
    getGlobalEmoteImages(),
    getChannelEmoteImages(broadcasterId),
    getSevenTvEmoteImages(broadcasterId),
  ]);
  return new Map([...global, ...channel, ...sevenTv]);
}

// Join emote usage counts (text names) to real images from the channel's own Twitch emotes,
// its 7TV set, and Twitch's global emotes. An emote that resolves to no image (e.g. removed
// from the set since it was counted) keeps imageUrl: null so the UI can fall back to its text
// form instead of dropping it. Returns a NEW array - callers pass repo results that may be
// cached, never mutate them.
async function withEmoteImages(channelLogin, emotes) {
  const channelDoc = await channelsRepo.findByLogin(channelLogin);
  const imageMap = await getEmoteImageMap(channelDoc?.channelId);
  return emotes.map((e) => ({ ...e, imageUrl: imageMap.get(e.word) ?? null }));
}

module.exports = {
  getEmoteImageMap,
  getGlobalEmoteImages,
  getChannelEmoteImages,
  getSevenTvEmoteImages,
  getSevenTvLinkStatus,
  withEmoteImages,
};
