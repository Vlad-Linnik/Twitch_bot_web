// Live/offline status for the channels listed on the home page (routes/home.js), via Helix
// "Get Streams" - same app-token auth as helixUsers.js/chatColor.js (client_credentials, no
// per-user scope needed to read public stream status).
//
// The home page is public and can get real traffic, and "is this channel live" doesn't need to
// be more real-time than "roughly current" for a directory listing, so results are cached in
// memory for a short TTL rather than hitting Helix on every render.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const MAX_PER_REQUEST = 100;
const CACHE_TTL_MS = 60 * 1000;

let cache = null; // { expiresAt, checkedIds: Set<string>, liveIds: Set<string> }

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function fetchLiveIds(userIds) {
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };
  const live = new Set();
  for (const batch of chunk(userIds, MAX_PER_REQUEST)) {
    const params = new URLSearchParams();
    for (const id of batch) params.append("user_id", id);
    const response = await axios.get(`${STREAMS_URL}?${params.toString()}`, { headers });
    for (const stream of response.data.data) live.add(String(stream.user_id));
  }
  return live;
}

// Returns Set<string userId> of the given ids that are currently live. Fail-soft on a Helix
// outage - falls back to the last good cache, or "nobody live" if there isn't one, rather than
// rejecting and taking the whole home page down with it.
async function getLiveChannelIds(userIds) {
  const ids = [...new Set(userIds.map(String))];
  if (ids.length === 0) return new Set();

  if (cache && cache.expiresAt > Date.now() && ids.every((id) => cache.checkedIds.has(id))) {
    return new Set(ids.filter((id) => cache.liveIds.has(id)));
  }

  try {
    const liveIds = await fetchLiveIds(ids);
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, checkedIds: new Set(ids), liveIds };
    return liveIds;
  } catch (err) {
    console.error("[streamStatus] Get Streams failed:", err.message);
    return cache ? new Set(ids.filter((id) => cache.liveIds.has(id))) : new Set();
  }
}

module.exports = { getLiveChannelIds };
