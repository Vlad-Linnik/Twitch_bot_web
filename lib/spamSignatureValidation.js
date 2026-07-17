// Validation for the per-spam-signature ban duration/reason feature. Pure, so it is
// unit-testable without Mongo (same reason lib/settingsValidation.js exists).
//
// A spam signature used to be a bare string, always resulting in a permanent ban with one
// shared reason (config.spamBanReason) - see TwitchBot/commands/msgHandle.js's spam_protection.
// Each signature can now carry its own ban duration (falling back to permanent) and its own
// reason (falling back to the shared spamBanReason) - see normalizeSignatureEntry for how
// pre-existing bare-string entries keep working without a separate migration script.
const { sanitizeWord } = require("./settingsValidation");

const MAX_REASON_LENGTH = 500;
const PERMANENT = "permanent";

// Seconds, matching Twitch's own Helix timeout bounds (TwitchBot/twitch/TwitchBanAPI.js's
// min_timeout/max_timeout - 1s to 2 weeks). "Permanent" skips the timeout endpoint entirely and
// calls /ban instead (see msgHandle.js), so it isn't just "the biggest timeout".
const DURATION_PRESETS = [
  { seconds: 600, labelKey: "duration10m" },
  { seconds: 3600, labelKey: "duration1h" },
  { seconds: 86400, labelKey: "duration1d" },
  { seconds: 604800, labelKey: "duration1w" },
  { seconds: 1209600, labelKey: "duration2w" },
];

function parseDuration(raw) {
  const value = String(raw ?? "").trim();
  if (value === "" || value === PERMANENT) return { ok: true, durationSeconds: null };
  const seconds = parseInt(value, 10);
  if (!DURATION_PRESETS.some((p) => p.seconds === seconds)) return { ok: false };
  return { ok: true, durationSeconds: seconds };
}

// Empty means "use the channel's shared spamBanReason" - see msgHandle.js's fallback.
function sanitizeReason(raw) {
  const text = String(raw ?? "").trim().slice(0, MAX_REASON_LENGTH);
  return text || null;
}

// A pre-existing entry may still be a bare string (created before this feature shipped) - treat
// it as permanent + the shared reason, same as its actual current behavior. Any save through
// parseSignatureEntry always writes the object shape, so this only matters for untouched rows.
function normalizeSignatureEntry(entry) {
  if (typeof entry === "string") return { word: entry, durationSeconds: null, reason: null };
  return { word: entry.word, durationSeconds: entry.durationSeconds ?? null, reason: entry.reason ?? null };
}

/**
 * @returns {{ok: true, entry: object} | {ok: false, error: string}}
 */
function parseSignatureEntry({ word, duration, reason }) {
  const sanitizedWord = sanitizeWord(word);
  if (!sanitizedWord) return { ok: false, error: "signature_required" };

  const durationResult = parseDuration(duration);
  if (!durationResult.ok) return { ok: false, error: "duration_invalid" };

  return {
    ok: true,
    entry: { word: sanitizedWord, durationSeconds: durationResult.durationSeconds, reason: sanitizeReason(reason) },
  };
}

module.exports = {
  DURATION_PRESETS,
  PERMANENT,
  MAX_REASON_LENGTH,
  parseDuration,
  sanitizeReason,
  normalizeSignatureEntry,
  parseSignatureEntry,
};
