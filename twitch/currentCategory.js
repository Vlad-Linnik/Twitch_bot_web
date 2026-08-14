// Resolves a channel's CURRENT Twitch stream category (game name) for the /commands reference
// page, so a custom command with per-category text overrides (categoryTexts - see
// db/customCommandsRepo.js) shows the text that would actually fire right now instead of always
// its base `result`. Same app-token auth as streamStatus.js/gameBoxArt.js (client_credentials, no
// per-user scope needed for the public Get Streams endpoint) - deliberately its own tiny
// single-channel cache rather than reusing streamStatus.js's, which is shaped around checking many
// home-page channels' live/offline status at once, not one channel's category on demand.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const CACHE_TTL_MS = 60 * 1000; // matches streamStatus.js - "roughly current" is enough here too

const cache = new Map(); // broadcasterId -> { category: string|null, expiresAt }

// Returns the channel's current category name, or null if offline/unknown. Fail-soft on a Helix
// outage - falls back to the last cached value (even if stale) rather than throwing and taking the
// /commands page down with it; with nothing cached yet, null just means no override gets shown.
async function getCurrentCategory(broadcasterId) {
  const id = String(broadcasterId);
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.category;

  try {
    const headers = {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      "Client-Id": env.twitchClientId,
    };
    const response = await axios.get(`${STREAMS_URL}?user_id=${encodeURIComponent(id)}`, { headers });
    const stream = response.data.data[0];
    const category = stream && stream.game_name ? stream.game_name : null;
    cache.set(id, { category, expiresAt: Date.now() + CACHE_TTL_MS });
    return category;
  } catch (err) {
    console.error("[currentCategory] Get Streams failed:", err.message);
    return cached ? cached.category : null;
  }
}

module.exports = { getCurrentCategory };
