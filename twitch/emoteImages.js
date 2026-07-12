// Resolves emote NAMES to image URLs, so stats pages can render the actual emote instead of
// its text signature. The bot's whiteList/WordLifetimeStats rows carry only {channel, word} -
// no ids, no images - so the join happens here, against the two sources the bot syncs from:
//
//   - the channel's 7TV emote set (ChannelConfig.sevenTv.emoteSetUrl, same link the bot uses)
//   - Twitch's official global emotes (Helix "Get Global Emotes", app token, no user scope)
//
// Both are fetched lazily and cached in memory: the Twitch global list is identical for every
// channel and changes rarely (hours-long TTL), the 7TV set is per-channel and editable by the
// owner (short TTL so a newly added emote shows up without a restart). Everything here is
// fail-soft - an unreachable 7TV/Helix just means fewer resolved images, never a 500: an emote
// with no image (e.g. removed from the set since it was counted) falls back to text in the view.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const GLOBAL_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes/global";
const SEVEN_TV_API = "https://7tv.io/v3";

const GLOBAL_TTL_MS = 12 * 60 * 60 * 1000;
const SEVEN_TV_TTL_MS = 10 * 60 * 1000;

let globalCache = null; // { map, expiresAt }
const sevenTvCache = new Map(); // emoteSetUrl -> { map, expiresAt }

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

// Accepts the same links the bot's sevenTv/SevenTvEmotes.js accepts: an emote-set link
// (7tv.app/emote-sets/<id>) or a user link (7tv.app/users/<id>), resolved to that user's
// active Twitch emote set.
function parseSevenTvLink(link) {
  const match = String(link).match(/7tv\.app\/(emote-sets|users)\/(\w+)/);
  if (!match) return null;
  return { type: match[1] === "users" ? "user" : "set", id: match[2] };
}

async function fetchSevenTvEmoteImages(emoteSetUrl) {
  const parsed = parseSevenTvLink(emoteSetUrl);
  if (!parsed) return new Map();

  let setId = parsed.id;
  if (parsed.type === "user") {
    const { data: user } = await axios.get(`${SEVEN_TV_API}/users/${parsed.id}`);
    const twitchConnection = user.connections?.find((c) => c.platform === "TWITCH");
    setId = twitchConnection?.emote_set_id ?? user.emote_sets?.[0]?.id;
    if (!setId) return new Map();
  }

  const { data: emoteSet } = await axios.get(`${SEVEN_TV_API}/emote-sets/${setId}`);
  const map = new Map();
  for (const emote of emoteSet.emotes || []) {
    // Set-local name (the alias actually typed in chat), matching what the bot whitelists.
    map.set(emote.name, `https://cdn.7tv.app/emote/${emote.id}/2x.webp`);
  }
  return map;
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

async function getSevenTvEmoteImages(emoteSetUrl) {
  if (!emoteSetUrl) return new Map();
  const cached = sevenTvCache.get(emoteSetUrl);
  if (cached && Date.now() < cached.expiresAt) return cached.map;
  try {
    const map = await fetchSevenTvEmoteImages(emoteSetUrl);
    sevenTvCache.set(emoteSetUrl, { map, expiresAt: Date.now() + SEVEN_TV_TTL_MS });
    return map;
  } catch (err) {
    console.error("[emoteImages] 7TV emote set fetch failed:", err.message);
    return cached?.map ?? new Map();
  }
}

// name -> image URL for everything resolvable for this channel. The channel's own 7TV alias
// wins a name collision with a Twitch global - same precedence the bot gives its whiteList.
async function getEmoteImageMap(emoteSetUrl) {
  const [global, sevenTv] = await Promise.all([getGlobalEmoteImages(), getSevenTvEmoteImages(emoteSetUrl)]);
  return new Map([...global, ...sevenTv]);
}

module.exports = { getEmoteImageMap, getGlobalEmoteImages, getSevenTvEmoteImages };
