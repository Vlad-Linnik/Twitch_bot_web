// Hand-kept copy of TwitchBot/config/knownBots.js's KNOWN_BOT_LOGINS (the repos don't import
// from each other - same convention as lib/textStats.js). Bots hold moderator status but are
// not people: the bot repo no longer writes their ModeratorStatistics/ModUpTimeStats rows, and
// this list is the display-side guard that keeps them out of the moderator statistics table
// (including the ModsList-driven "no data" rows) even where legacy rows still exist. Their
// entries in "Recent moderator actions" are shown on purpose - automated bans are still part
// of the channel's moderation history.
const KNOWN_BOT_LOGINS = ["chatwizardbot", "moobot", "mistercopus_bot"];

const knownBotLogins = new Set(KNOWN_BOT_LOGINS);

// Matched against resolved display names / logins, case-insensitively - the web side has no
// cheap login->id map for arbitrary bots, but every row it renders already carries a resolved
// name, and a bot account's display name matches its login.
function isKnownBotName(name) {
  return knownBotLogins.has(String(name || "").toLowerCase());
}

module.exports = { KNOWN_BOT_LOGINS, isKnownBotName };
