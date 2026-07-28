// Validation for long-ban writes. Pure, so it is unit-testable without Mongo (same reason
// lib/commandValidation.js/lib/settingsValidation.js exist - see CLAUDE.md, "Testing").
//
// These rules are NOT invented here: they mirror exactly what the bot enforces for !longban
// (TwitchBot/commands/longBan.js's resolveUnbanAt), hand-synced since the two repos share no
// code (same convention as lib/commandValidation.js/lib/textStats.js). Anything looser here would
// let this panel create a long-ban the chat command itself would have rejected - see
// ../CLAUDE.md's "Long-bans: written by both repos, executed only by the bot".

const DURATION_UNIT_SECONDS = { d: 86400, w: 604800, m: 2_592_000, y: 31_536_000 };
// The actual ceiling ECMAScript Date / MongoDB's BSON date can represent (~year 275760-09-13).
const MAX_UNBAN_YEAR = 275760;
const MAX_REASON_LENGTH = 480;

const ABSOLUTE_DATE_REGEX = /^(\d{1,2})\.(\d{1,2})\.(\d{4,6})$/;
const RELATIVE_DURATION_REGEX = /^(\d+)([dwmy])?$/i;

// Accepts either an absolute "ДД.ММ.ГГГГ" date (local midnight) or a relative duration (a bare
// number of seconds, or a number with a d/w/m/y suffix). Returns { ok: true, unbanAt } or
// { ok: false, reason: 'format' | 'overflow' | 'past' }.
function resolveUnbanAt(token, now) {
  const raw = String(token || "").trim();

  const dateMatch = ABSOLUTE_DATE_REGEX.exec(raw);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);
    if (year > MAX_UNBAN_YEAR) return { ok: false, reason: "overflow" };
    if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "format" };

    const unbanAt = new Date(year, month - 1, day, 0, 0, 0, 0);
    if (isNaN(unbanAt.getTime()) || unbanAt.getMonth() !== month - 1 || unbanAt.getDate() !== day) {
      return { ok: false, reason: "format" };
    }
    if (unbanAt.getTime() <= now) return { ok: false, reason: "past" };
    return { ok: true, unbanAt };
  }

  const relMatch = RELATIVE_DURATION_REGEX.exec(raw);
  if (!relMatch) return { ok: false, reason: "format" };
  const value = parseInt(relMatch[1], 10);
  const unit = relMatch[2] ? relMatch[2].toLowerCase() : null;
  const seconds = unit ? value * DURATION_UNIT_SECONDS[unit] : value;
  if (seconds <= 0) return { ok: false, reason: "format" };
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) return { ok: false, reason: "overflow" };

  const unbanAt = new Date(now + seconds * 1000);
  if (isNaN(unbanAt.getTime()) || unbanAt.getFullYear() > MAX_UNBAN_YEAR) return { ok: false, reason: "overflow" };
  return { ok: true, unbanAt };
}

function normalizeLogin(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^@/, "");
}

/**
 * @returns {{ok: true, userLogin: string, mode: string, reason: string, unbanAt: Date} | {ok: false, error: string}}
 */
function parseLongBanRequest({ userLogin, mode, reason, duration, now = Date.now() }) {
  const login = normalizeLogin(userLogin);
  if (!login) return { ok: false, error: "user_required" };

  // Empty/missing defaults to 'timeout' (matches TwitchBot/commands/longBan.js's chat command,
  // where the mode argument is likewise optional) - only an explicit, unrecognized value is
  // rejected. The <select> on the create form always submits a value, so this only matters for a
  // request built some other way (e.g. a raw POST).
  const rawMode = String(mode || "").toLowerCase();
  const normalizedMode = rawMode || "timeout";
  if (normalizedMode !== "timeout" && normalizedMode !== "ban") return { ok: false, error: "mode_invalid" };

  const resolved = resolveUnbanAt(duration, now);
  if (!resolved.ok) return { ok: false, error: `duration_${resolved.reason}` };

  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length > MAX_REASON_LENGTH) return { ok: false, error: "reason_too_long" };

  return {
    ok: true,
    userLogin: login,
    mode: normalizedMode,
    reason: trimmedReason || "No reason",
    unbanAt: resolved.unbanAt,
  };
}

module.exports = {
  resolveUnbanAt,
  parseLongBanRequest,
  normalizeLogin,
  MAX_UNBAN_YEAR,
  MAX_REASON_LENGTH,
};
