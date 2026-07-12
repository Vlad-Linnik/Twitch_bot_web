// Fetches a Twitch user's chat color via Helix "Get User Chat Color"
// (https://dev.twitch.tv/docs/api/reference/#get-user-chat-color), using the
// shared app access token - no user-specific scope needed, this is public data.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");

const CHAT_COLOR_URL = "https://api.twitch.tv/helix/chat/color";
const MAX_PER_REQUEST = 100;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// Returns a Map<userId, color|null> - color is null if the user has never set one.
async function getChatColors(userIds) {
  const normalized = [...new Set(userIds.map((id) => `${id}`.trim()).filter(Boolean))];
  const result = new Map();
  if (!normalized.length) return result;

  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": env.twitchClientId,
  };

  for (const batch of chunk(normalized, MAX_PER_REQUEST)) {
    const params = new URLSearchParams();
    for (const id of batch) params.append("user_id", id);
    const response = await axios.get(`${CHAT_COLOR_URL}?${params.toString()}`, { headers });
    for (const entry of response.data.data) {
      result.set(entry.user_id, entry.color || null);
    }
  }
  return result;
}

module.exports = { getChatColors };
