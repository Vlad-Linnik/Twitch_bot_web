// Personal /settings - language preference + profile privacy. Distinct from the per-channel
// /:channel/settings (routes/settings.js): login-required only, no
// permission-tier gate, since these are the visitor's own preferences.
//
// The chat-name-color preference (chatColorMode/customChatColor) is temporarily
// NOT editable here (section removed from the view, 2026-07). The handler must
// not touch those fields: savePreferences $sets only what it's given, so
// already-saved colors survive every locale save and keep applying site-wide
// via middleware/navMenu.js.
const express = require("express");
const userPreferencesRepo = require("../db/userPreferencesRepo");
const { resolvePrivacy } = require("../lib/privacy");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { isSupportedLocale } = require("../config/i18n");
const { persistLocaleCookie } = require("../middleware/i18n");

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).render("errors/403", { requiredLevel: null });
  }
  next();
}

router.get("/settings", requireLogin, async (req, res, next) => {
  try {
    const prefs = await userPreferencesRepo.getPreferences(req.user.userId);
    res.render("accountSettings", {
      prefs: prefs || {},
      privacy: resolvePrivacy(prefs),
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings", settingsWriteLimiter, requireLogin, verifyToken, async (req, res, next) => {
  try {
    const locale = isSupportedLocale(req.body.locale) ? req.body.locale : "en";

    await userPreferencesRepo.savePreferences(req.user.userId, {
      locale,
      // Unchecked boxes are simply absent from a form body, so all three privacy booleans
      // are written explicitly on every save (the whole form always submits together).
      hideMessageVolume: req.body.hideMessageVolume === "on",
      hideChatActivity: req.body.hideChatActivity === "on",
      hideProfile: req.body.hideProfile === "on",
    });

    // The "lang" cookie outranks the saved preference in middleware/i18n.js's resolveLocale(),
    // so without rewriting it here the language choice saves but never takes effect.
    persistLocaleCookie(res, locale);

    res.redirect("/settings?saved=1");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
