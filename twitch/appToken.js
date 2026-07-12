// Shared Twitch app access token (client_credentials grant), used by any Helix
// call that doesn't need a specific user's own token (Get Users, Get Chat Color).
// Extracted out of helixUsers.js so chatColor.js can reuse it instead of each
// module fetching/caching its own token.
const axios = require("axios");
const env = require("../config/env");

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

let appAccessToken = null;
let appTokenExpiresAt = 0;

async function ensureAppAccessToken() {
  if (appAccessToken && Date.now() < appTokenExpiresAt) return appAccessToken;
  const response = await axios.post(TOKEN_URL, null, {
    params: {
      client_id: env.twitchClientId,
      client_secret: env.twitchClientSecret,
      grant_type: "client_credentials",
    },
  });
  appAccessToken = response.data.access_token;
  appTokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
  return appAccessToken;
}

module.exports = { ensureAppAccessToken };
