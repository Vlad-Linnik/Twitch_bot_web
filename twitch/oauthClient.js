// Twitch "Login with Twitch" Authorization Code flow for website visitors.
// Separate from the bot's own TokenManager.js flow (different Twitch Dev
// Console app, different purpose: identity only, not a chat/moderation actor).
const axios = require("axios");
const crypto = require("crypto");
const env = require("../config/env");

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const USERS_URL = "https://api.twitch.tv/helix/users";

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: env.twitchClientId,
    redirect_uri: env.twitchRedirectUri,
    response_type: "code",
    // moderation:read backs the owner-triggered ModsList sync (see
    // twitch/channelModerators.js) - when a channel owner logs in, we use their own
    // token to pull Twitch's canonical moderator list for their channel. Requested
    // from every visitor up front (Twitch scopes can't be requested conditionally
    // at redirect time), but only ever exercised for the subset who own a channel.
    // (Get Moderators accepts moderation:read OR channel:manage:moderators - the
    // latter also grants add/remove rights we don't need, so the read-only one wins.)
    scope: "moderation:read",
    state,
    force_verify: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const response = await axios.post(TOKEN_URL, null, {
    params: {
      client_id: env.twitchClientId,
      client_secret: env.twitchClientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: env.twitchRedirectUri,
    },
  });
  return response.data; // { access_token, refresh_token, expires_in, scope, token_type }
}

// Used by twitch/moderatorSyncScheduler.js to turn a persisted refresh_token into a fresh
// access_token between logins. Twitch rotates the refresh_token on every use - callers must
// persist response.data.refresh_token, not reuse the one they passed in.
async function refreshAccessToken(refreshToken) {
  const response = await axios.post(TOKEN_URL, null, {
    params: {
      client_id: env.twitchClientId,
      client_secret: env.twitchClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  });
  return response.data; // { access_token, refresh_token, expires_in, scope, token_type }
}

async function getAuthenticatedUser(userAccessToken) {
  const response = await axios.get(USERS_URL, {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      "Client-Id": env.twitchClientId,
    },
  });
  const user = response.data.data[0];
  if (!user) throw new Error("Twitch did not return a user for this token");
  return {
    userId: user.id,
    login: user.login,
    displayName: user.display_name,
    avatarUrl: user.profile_image_url,
  };
}

module.exports = {
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getAuthenticatedUser,
};
