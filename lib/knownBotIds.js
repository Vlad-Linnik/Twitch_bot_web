// Resolves config/knownBots.js's login list to numeric Twitch user IDs.
//
// Why this exists: that list is logins, and everywhere else in this app bot accounts get filtered
// out by comparing RESOLVED DISPLAY NAMES (routes/statistics.js's isKnownBotName). That works for
// the moderator table, which has already resolved every name for rendering anyway. It does not
// work for the unban dossier, which needs to COUNT a user's bans/timeouts "from humans only" -
// counting means a Mongo filter on ModeratorActionLogs.modID, and modID is an id.
//
// Resolved once per process and memoized: the list is three static logins, and their ids never
// change. A failed lookup is NOT cached, so a Helix blip at the wrong moment doesn't permanently
// disable bot filtering for the process's lifetime.
const { KNOWN_BOT_LOGINS } = require("../config/knownBots");
const { getUsersByLogin } = require("../twitch/helixUsers");

let cached = null;
let inFlight = null;

// Returns { ids: string[], logins: string[] } - BOTH, because some legacy ModeratorActionLogs rows
// predate the bot writing numeric ids and hold a login string in `modID` instead. A $nin filter
// therefore has to exclude both spellings to actually drop every bot-issued action.
async function getKnownBotIdentifiers() {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const logins = KNOWN_BOT_LOGINS.map((login) => login.toLowerCase());
    let ids = [];
    try {
      const users = await getUsersByLogin(logins);
      ids = users.map((user) => String(user.id));
    } catch (err) {
      // Fail soft: the dossier still renders, it just counts bot actions as human ones for this
      // request. Better than 500-ing a moderation tool over a profile lookup.
      console.error("[knownBotIds] Failed to resolve bot logins to ids:", err.message);
      inFlight = null;
      return { ids: [], logins };
    }
    cached = { ids, logins };
    inFlight = null;
    return cached;
  })();

  return inFlight;
}

module.exports = { getKnownBotIdentifiers };
