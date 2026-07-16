// Twitch "Get Moderators" (https://dev.twitch.tv/docs/api/reference/#get-moderators) -
// the canonical list of a channel's moderators. Requires a user access token whose
// owner IS the broadcaster being queried (scope moderation:read) - unlike
// Get Moderated Channels (self-report, any user), this only works when the channel
// owner themselves is the one logged in. See TwitchBot/twitch/moderators.js for why
// the bot itself can never reach this endpoint (it only ever holds its own token).
const axios = require("axios");
const env = require("../config/env");

const MODERATORS_URL = "https://api.twitch.tv/helix/moderation/moderators";
const MAX_PER_PAGE = 100;

async function getModerators(userAccessToken, broadcasterId) {
  const headers = {
    Authorization: `Bearer ${userAccessToken}`,
    "Client-Id": env.twitchClientId,
  };

  const moderators = [];
  let cursor;
  do {
    const response = await axios.get(MODERATORS_URL, {
      headers,
      params: {
        broadcaster_id: broadcasterId,
        first: MAX_PER_PAGE,
        ...(cursor ? { after: cursor } : {}),
      },
    });
    for (const entry of response.data.data) {
      moderators.push({ userId: entry.user_id, userLogin: entry.user_login });
    }
    cursor = response.data.pagination?.cursor || null;
  } while (cursor);

  return moderators;
}

module.exports = { getModerators };
