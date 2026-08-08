// Parses the "Бюро амнистии" (Amnesty Bureau) block of the channel-settings form.
//
// Extracted out of lib/settingsValidation.js's parseSubmittedConfig rather than written inline
// there, per this repo's convention that route/parse logic worth testing lives in lib/ with a
// tests/*.test.js beside it (see lib/settingsValidation.js's own header).
//
// The bounds below are HAND-MIRRORED from TwitchBot/twitch/unbanRequestScheduler.js's
// MIN_VOTE_SEC/MAX_VOTE_SEC/MIN_SNIPER_SEC/MAX_SNIPER_SEC - the same copy-by-hand convention as
// lib/commandValidation.js and lib/textStats.js, because the repos may not import each other. The
// bot clamps these again on its own side regardless: this is so the moderator sees the value that
// will actually be used, not so the bot can trust the input.
const MIN_VOTE_SEC = 15;
const MAX_VOTE_SEC = 600;
const MIN_SNIPER_SEC = 1;
const MAX_SNIPER_SEC = 3600;
const MAX_REASON_LEN = 140; // Twitch's ban/timeout reason cap is 500; this is a chat-facing one-liner.

const DEFAULTS = {
  enabled: false,
  voteApproveEmote: "VoteYea",
  voteDenyEmote: "VoteNay",
  voteDurationSec: 60,
  sniperEnabled: false,
  sniperMode: "timeout",
  sniperTimeoutSec: 60,
  sniperReason: "Шальная пуля Бюро амнистии",
};

function clampInt(raw, min, max, fallback) {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// A vote emote is a bare chat token, so anything with whitespace in it could never be typed as one
// vote. Empty falls back to the default rather than disabling voting silently.
function sanitizeEmote(raw, fallback) {
  const value = String(raw ?? "").trim().split(/\s+/)[0] || "";
  return value ? value.slice(0, 40) : fallback;
}

// `existing` is the channel's stored unbanBureau block (or undefined for a channel that predates
// the feature). Every field absent from `body` carries over from it unchanged - the same
// partial-form contract parseSubmittedConfig documents, which is what lets the settings sub-pages
// save a subset of the form without wiping this block.
function parseUnbanBureau(body, existing) {
  const current = { ...DEFAULTS, ...(existing || {}) };

  // Checkboxes submit nothing when unchecked, which is indistinguishable from "not on this form".
  // Same `.present` marker trick the command toggles use.
  const enabled =
    body["unbanBureau.present"] === "1" ? body["unbanBureau.enabled"] === "on" : current.enabled;
  const sniperEnabled =
    body["unbanBureau.present"] === "1"
      ? body["unbanBureau.sniperEnabled"] === "on"
      : current.sniperEnabled;

  return {
    enabled,
    voteApproveEmote:
      body["unbanBureau.voteApproveEmote"] !== undefined
        ? sanitizeEmote(body["unbanBureau.voteApproveEmote"], DEFAULTS.voteApproveEmote)
        : current.voteApproveEmote,
    voteDenyEmote:
      body["unbanBureau.voteDenyEmote"] !== undefined
        ? sanitizeEmote(body["unbanBureau.voteDenyEmote"], DEFAULTS.voteDenyEmote)
        : current.voteDenyEmote,
    voteDurationSec:
      body["unbanBureau.voteDurationSec"] !== undefined
        ? clampInt(body["unbanBureau.voteDurationSec"], MIN_VOTE_SEC, MAX_VOTE_SEC, current.voteDurationSec)
        : current.voteDurationSec,
    sniperEnabled,
    // Anything that isn't the literal 'ban' means 'timeout' - the milder of the two, so a garbled
    // value can never escalate a channel to real bans.
    sniperMode:
      body["unbanBureau.sniperMode"] !== undefined
        ? body["unbanBureau.sniperMode"] === "ban"
          ? "ban"
          : "timeout"
        : current.sniperMode,
    sniperTimeoutSec:
      body["unbanBureau.sniperTimeoutSec"] !== undefined
        ? clampInt(
            body["unbanBureau.sniperTimeoutSec"],
            MIN_SNIPER_SEC,
            MAX_SNIPER_SEC,
            current.sniperTimeoutSec
          )
        : current.sniperTimeoutSec,
    sniperReason:
      body["unbanBureau.sniperReason"] !== undefined
        ? String(body["unbanBureau.sniperReason"] ?? "").trim().slice(0, MAX_REASON_LEN) ||
          DEFAULTS.sniperReason
        : current.sniperReason,
  };
}

module.exports = {
  DEFAULTS,
  MIN_VOTE_SEC,
  MAX_VOTE_SEC,
  MIN_SNIPER_SEC,
  MAX_SNIPER_SEC,
  MAX_REASON_LEN,
  parseUnbanBureau,
};
