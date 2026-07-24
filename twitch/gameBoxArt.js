// Resolves Twitch category (game) NAMES → box-art image URLs via Helix "Get Games", so the
// stream-stats chart's category strip can show each category's cover art. Same app-token auth as
// streamStatus.js/helixUsers.js (client_credentials, no per-user scope needed to read the public
// games directory).
//
// Box art is keyed by game name here on purpose: the stream chart only stores the category NAME
// per viewer sample (StreamViewerSamples.category), never the numeric game id, so name is all we
// have to resolve from. Names are stable and the id→art mapping changes rarely, so results are
// cached in memory for a long TTL and negatively cached too (a name Twitch doesn't know - e.g. a
// since-renamed category - must not be re-queried on every chart render).
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const GAMES_URL = "https://api.twitch.tv/helix/games";
const MAX_PER_REQUEST = 100; // Helix caps `name` repetitions per Get Games call at 100
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // box art changes about never; a day is plenty

// The box_art_url Helix returns is a template with {width}x{height} placeholders. Twitch cover
// art is 3:4 portrait; 144x192 is a crisp 2x for the ~24px-tall thumbnail the chart renders.
const BOX_W = 144;
const BOX_H = 192;

const cache = new Map(); // lowercased name -> { url: string|null, expiresAt }

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function fillTemplate(boxArtUrl) {
  return boxArtUrl.replace("{width}", String(BOX_W)).replace("{height}", String(BOX_H));
}

async function fetchBoxArt(names) {
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const resolved = new Map(); // lowercased name -> url
  for (const batch of chunk(names, MAX_PER_REQUEST)) {
    const params = new URLSearchParams();
    for (const name of batch) params.append("name", name);
    const response = await axios.get(`${GAMES_URL}?${params.toString()}`, { headers });
    for (const game of response.data.data || []) {
      if (game.name && game.box_art_url) resolved.set(game.name.toLowerCase(), fillTemplate(game.box_art_url));
    }
  }
  return resolved;
}

// Returns Map<originalName, boxArtUrl> for the subset of the given category names that resolve to
// a box art image. Fail-soft: on a Helix outage returns whatever is already cached and leaves the
// rest unresolved (the chart just renders those segments without an image), never rejecting and
// taking the chart payload down with it.
async function getBoxArtUrls(names) {
  const now = Date.now();
  const distinct = [...new Set(names.filter((n) => n && n.trim()))];
  const result = new Map();
  const misses = [];

  for (const name of distinct) {
    const hit = cache.get(name.toLowerCase());
    if (hit && hit.expiresAt > now) {
      if (hit.url) result.set(name, hit.url);
    } else {
      misses.push(name);
    }
  }

  if (misses.length === 0) return result;

  try {
    const fetched = await fetchBoxArt(misses);
    const expiresAt = now + CACHE_TTL_MS;
    for (const name of misses) {
      const url = fetched.get(name.toLowerCase()) || null;
      cache.set(name.toLowerCase(), { url, expiresAt }); // negative-cache unknown names too
      if (url) result.set(name, url);
    }
  } catch (err) {
    console.error("[gameBoxArt] Get Games failed:", err.message);
    // result already holds the cache hits; leave the misses unresolved.
  }

  return result;
}

module.exports = { getBoxArtUrls };
