// Seasonal site themes: the tier-0 override page and the viewer's own on/off switch.
// The decision itself is lib/seasonalThemes.js; this file only reads and writes the two inputs.
const express = require("express");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter, autosaveLimiter } = require("../middleware/rateLimiters");
const siteSettingsRepo = require("../db/siteSettingsRepo");
const userPreferencesRepo = require("../db/userPreferencesRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const {
  SEASONAL_THEMES,
  SEASON_TIME_ZONE,
  parseOverride,
  overrideToFormValue,
  normalizeDecorPref,
  themeForDate,
  nextStart,
  windowFor,
} = require("../lib/seasonalThemes");

const router = express.Router();
const requireAdmin = requireLevel(0);

router.get("/admin/seasonal-theme", requireAdmin, async (req, res, next) => {
  try {
    const override = await siteSettingsRepo.getSeasonalOverride();
    const now = new Date();
    res.render("adminSeasonalTheme", {
      tab: "seasonal-theme",
      override,
      formValue: overrideToFormValue(override),
      calendarTheme: themeForDate(now),
      themes: SEASONAL_THEMES.map((theme) => {
        const next = nextStart(theme, now);
        // The window of the year it next starts in - a movable one differs from year to year.
        return { id: theme.id, next, window: windowFor(theme, next.year) };
      })
        // Listed by when they next come round, not in SEASONAL_THEMES' priority order.
        .sort((a, b) => Date.UTC(a.next.year, a.next.month - 1, a.next.day) - Date.UTC(b.next.year, b.next.month - 1, b.next.day)),
      timeZone: SEASON_TIME_ZONE,
      saved: req.query.saved === "1",
      invalid: req.query.invalid === "1",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/seasonal-theme", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const override = parseOverride(req.body);
    if (!override) return res.redirect("/admin/seasonal-theme?invalid=1");
    const before = await siteSettingsRepo.getSeasonalOverride();
    await siteSettingsRepo.saveSeasonalOverride(override, req.user);
    const from = overrideToFormValue(before);
    const to = overrideToFormValue(override);
    if (from !== to) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "site.seasonalTheme",
        target: to,
        details: `${from} → ${to}`,
      });
    }
    res.redirect("/admin/seasonal-theme?saved=1");
  } catch (err) {
    next(err);
  }
});

// The viewer's switch in the nav (public/js/seasonal-theme.js). Logged-in only - a guest's
// choice never leaves their browser. Autosave bucket, not the explicit-action one: it is a
// toggle that can be flicked a few times in a row.
router.post("/season/decor", autosaveLimiter, verifyToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: "login" });
    const pref = normalizeDecorPref(req.body.pref);
    if (!pref) return res.status(400).json({ ok: false, error: "pref" });
    await userPreferencesRepo.savePreferences(req.user.userId, { seasonalDecor: pref });
    res.json({ ok: true, pref });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
