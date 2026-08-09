// Validates the "решение вступает в силу" (effective-date) field on an unban-bureau approval -
// see routes/unbanBureau.js's decide.json. Extracted to lib/ per this repo's convention that
// route-level parsing worth testing lives here (see lib/settingsValidation.js's own header).
//
// The max-representable-year guard mirrors the LongBans convention (TwitchBot/commands/longBan.js's
// resolveUnbanAt / lib/longBanValidation.js), hand-synced for the same reason those are (the repos
// share no code - see ../CLAUDE.md, "Long-bans"). Unlike LongBans there's no dd.mm.yyyy parsing to
// mirror: the field is a native <input type="date">, which always submits "YYYY-MM-DD" regardless
// of the page's locale.
const MAX_YEAR = 275760; // ~year 275760-09-13, the actual ceiling a JS Date/BSON date can represent.
const DATE_REGEX = /^(\d{4,6})-(\d{2})-(\d{2})$/;

// Empty/missing means "immediately", the default a blank field carries. Returns
// { ok: true, effectiveAt: Date|null } or { ok: false, reason: 'format' | 'overflow' | 'past' }.
function parseEffectiveAt(raw, now = Date.now()) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: true, effectiveAt: null };

  const match = DATE_REGEX.exec(trimmed);
  if (!match) return { ok: false, reason: "format" };

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (year > MAX_YEAR) return { ok: false, reason: "overflow" };
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "format" };

  const effectiveAt = new Date(year, month - 1, day, 0, 0, 0, 0);
  // getMonth()/getDate() disagreeing with what was parsed means the date rolled over
  // (e.g. 31.02.2030 -> early March) - reject rather than silently substitute a nearby date.
  if (isNaN(effectiveAt.getTime()) || effectiveAt.getMonth() !== month - 1 || effectiveAt.getDate() !== day) {
    return { ok: false, reason: "format" };
  }
  if (effectiveAt.getTime() <= now) return { ok: false, reason: "past" };
  return { ok: true, effectiveAt };
}

module.exports = { parseEffectiveAt, MAX_YEAR };
