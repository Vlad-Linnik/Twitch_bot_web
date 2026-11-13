// Seasonal site themes: which one (if any) is in effect right now.
//
// Pure: no DB, no clock of its own. The caller passes the moment and the admin override
// (db/siteSettingsRepo.js), and gets back a theme id or null. Everything a new theme needs from
// the server side is ONE entry in SEASONAL_THEMES below - the date window lives here and nowhere
// else. Its look lives in public/css/input.css under html[data-season="<id>"] and its behaviour
// (if any) in public/js/seasonal-theme.js, both keyed by the same id.

// The calendar the windows are read in. Pinned rather than taken from the server's own zone:
// the VPS clock's zone is an accident of how the machine was provisioned, while "the holidays
// started" is a date in the audience's calendar - and a test must not pass or fail depending on
// where it is run.
const SEASON_TIME_ZONE = "Europe/Moscow";

// Windows are inclusive at both ends and may wrap the new year (start later in the calendar
// than end). On an overlap the first listed theme wins, so a short event listed early can sit
// inside a longer season.
const SEASONAL_THEMES = Object.freeze([
  Object.freeze({
    id: "newyear",
    start: Object.freeze({ month: 12, day: 20 }),
    end: Object.freeze({ month: 1, day: 10 }),
  }),
]);

const OVERRIDE_MODES = Object.freeze(["auto", "force", "off"]);
const DEFAULT_OVERRIDE = Object.freeze({ mode: "auto", themeId: null });

const monthDayFormatters = new Map();
function monthDayIn(date, timeZone) {
  let fmt = monthDayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" });
    monthDayFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);
  return { month, day };
}

// Month/day compared as one ordinal (month*100 + day) - no year, so a window is the same every
// year and a wrapping window is just "after start OR before end".
function ordinal({ month, day }) {
  return month * 100 + day;
}

function isInWindow(monthDay, theme) {
  const at = ordinal(monthDay);
  const from = ordinal(theme.start);
  const to = ordinal(theme.end);
  return from <= to ? at >= from && at <= to : at >= from || at <= to;
}

function findTheme(id, themes = SEASONAL_THEMES) {
  return themes.find((theme) => theme.id === id) || null;
}

function themeForDate(date, { themes = SEASONAL_THEMES, timeZone = SEASON_TIME_ZONE } = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const monthDay = monthDayIn(date, timeZone);
  const match = themes.find((theme) => isInWindow(monthDay, theme));
  return match ? match.id : null;
}

// The whole decision. A forced theme whose id no longer exists (a theme removed from the list
// while the override still names it) falls back to the calendar rather than to "off": a stale
// override must not silently switch the seasons off for good.
function resolveSeasonalTheme({ now = new Date(), override, themes = SEASONAL_THEMES, timeZone = SEASON_TIME_ZONE } = {}) {
  const mode = override && OVERRIDE_MODES.includes(override.mode) ? override.mode : "auto";
  if (mode === "off") return null;
  if (mode === "force") {
    const forced = findTheme(override.themeId, themes);
    if (forced) return forced.id;
  }
  return themeForDate(now, { themes, timeZone });
}

// Admin form body -> a storable override, or null when the body is not one. The form posts a
// single select whose values are "auto", "off" or "force:<themeId>".
function parseOverride(body, themes = SEASONAL_THEMES) {
  const raw = body && typeof body.seasonMode === "string" ? body.seasonMode.trim() : "";
  if (raw === "auto" || raw === "off") return { mode: raw, themeId: null };
  if (raw.startsWith("force:")) {
    const theme = findTheme(raw.slice("force:".length), themes);
    if (theme) return { mode: "force", themeId: theme.id };
  }
  return null;
}

// What a stored override looks like as the admin select's value - the inverse of parseOverride.
function overrideToFormValue(override) {
  if (override && override.mode === "force" && override.themeId) return `force:${override.themeId}`;
  if (override && override.mode === "off") return "off";
  return "auto";
}

// A viewer's own choice (UserPreferences.seasonalDecor / the guest's localStorage):
//   "full"   - decor and animation, even under prefers-reduced-motion
//   "static" - decor, no animation
//   "off"    - nothing
// Absent means the default: decor on, animation unless the OS asks for reduced motion - a
// decision only the browser can finish, so the server passes the raw value through.
const DECOR_PREFS = Object.freeze(["full", "static", "off"]);

function normalizeDecorPref(value) {
  return DECOR_PREFS.includes(value) ? value : null;
}

// The next date each theme starts on or after `now` - for the admin page, so "auto" can say
// when it will next change something.
function nextStart(theme, now = new Date(), timeZone = SEASON_TIME_ZONE) {
  const today = monthDayIn(now, timeZone);
  const year = Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now));
  const startYear = ordinal(theme.start) >= ordinal(today) ? year : year + 1;
  return { year: startYear, month: theme.start.month, day: theme.start.day };
}

module.exports = {
  SEASON_TIME_ZONE,
  SEASONAL_THEMES,
  OVERRIDE_MODES,
  DEFAULT_OVERRIDE,
  DECOR_PREFS,
  isInWindow,
  findTheme,
  themeForDate,
  resolveSeasonalTheme,
  parseOverride,
  overrideToFormValue,
  normalizeDecorPref,
  nextStart,
};
