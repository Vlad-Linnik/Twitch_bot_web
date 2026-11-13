// Exposes the seasonal theme to every view:
//   res.locals.seasonalTheme      - theme id ("newyear") or null (lib/seasonalThemes.js decides)
//   res.locals.seasonalDecorPref  - the logged-in viewer's own choice ("full"|"static"|"off") or
//                                   null; guests keep theirs in localStorage, read by head.ejs
//   res.locals.seasonalQuiet      - true on pages where the moving parts (falling snow, cursor,
//                                   trail) must stay off - see QUIET_PATH below
//
// Mounted after middleware/auth.js. The preference costs a query only while a theme is actually
// on - for ten and a half months of the year this middleware reads one cached document and stops.
const siteSettingsRepo = require("../db/siteSettingsRepo");
const userPreferencesRepo = require("../db/userPreferencesRepo");
const { resolveSeasonalTheme, normalizeDecorPref } = require("../lib/seasonalThemes");

// Games draw on a canvas at full frame rate and several are steered by the pointer (Pong's
// paddle, the Bureau's sniper scope): a cursor that is not a precise arrow, and a second canvas
// redrawing over theirs, cost the player exactly what the game is about. Static decor stays.
const QUIET_PATH = /^\/games\/|^\/[^/]+\/unban-bureau(?:\/|$)/;

async function seasonalThemeMiddleware(req, res, next) {
  res.locals.seasonalTheme = null;
  res.locals.seasonalDecorPref = null;
  res.locals.seasonalQuiet = QUIET_PATH.test(req.path);

  try {
    const override = await siteSettingsRepo.getSeasonalOverride();
    const theme = resolveSeasonalTheme({ now: new Date(), override });
    res.locals.seasonalTheme = theme;
    if (theme && req.user) {
      const prefs = await userPreferencesRepo.getPreferences(req.user.userId);
      res.locals.seasonalDecorPref = normalizeDecorPref(prefs && prefs.seasonalDecor);
    }
  } catch (err) {
    // The theme is decoration: a failure here renders the page undecorated, never an error.
    console.error("[seasonalTheme] Failed to resolve, rendering without a theme:", err.message);
  }
  next();
}

module.exports = seasonalThemeMiddleware;
