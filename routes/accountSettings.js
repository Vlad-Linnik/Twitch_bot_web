// Personal /settings - language + chat-color preference. Distinct from the
// per-channel /:channel/settings (routes/settings.js): login-required only,
// no permission-tier gate, since these are the visitor's own preferences.
const express = require("express");
const userPreferencesRepo = require("../db/userPreferencesRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { isSupportedLocale } = require("../config/i18n");

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).render("errors/403", { requiredLevel: null });
  }
  next();
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

router.get("/settings", requireLogin, async (req, res, next) => {
  try {
    const [prefs, profile] = await Promise.all([
      userPreferencesRepo.getPreferences(req.user.userId),
      profileCacheRepo.getOrFetchProfile(req.user.userId),
    ]);
    res.render("accountSettings", { prefs: prefs || {}, profile, saved: req.query.saved === "1" });
  } catch (err) {
    next(err);
  }
});

router.post("/settings", settingsWriteLimiter, requireLogin, verifyToken, async (req, res, next) => {
  try {
    const locale = isSupportedLocale(req.body.locale) ? req.body.locale : "en";
    const chatColorMode = req.body.chatColorMode === "custom" ? "custom" : "twitch";
    const customChatColor = HEX_COLOR_RE.test(req.body.customChatColor || "") ? req.body.customChatColor : null;

    await userPreferencesRepo.savePreferences(req.user.userId, { locale, chatColorMode, customChatColor });

    res.redirect("/settings?saved=1");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
