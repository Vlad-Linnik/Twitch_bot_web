// Locale resolution, in priority order:
//   ?lang= query param (persists via cookie + redirects to the clean URL)
//   > "lang" cookie
//   > saved account preference (if logged in)
//   > FIRST-VISIT DETECTION: Accept-Language, then a proxy country header - and the result is
//     PERSISTED, so it becomes a real stored choice rather than being re-derived from headers on
//     every request. The detection itself lives in lib/localeDetection.js (pure, unit-tested).
//   > default "en"
//
// Exposes res.locals.t()/res.locals.locale to every view. Mounted after middleware/auth.js (needs
// req.user) and after middleware/session.js (uses the "cookie" package directly - already a
// transitive dep of express-session - since there's no cookie-parser mounted).
const cookie = require("cookie");
const { translate, isSupportedLocale, DEFAULT_LOCALE, NATIVE_LANGUAGE_NAMES } = require("../config/i18n");
const { localeFromAcceptLanguage, localeFromCountry } = require("../lib/localeDetection");
const userPreferencesRepo = require("../db/userPreferencesRepo");

const COOKIE_NAME = "lang";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year, seconds

// res.append (not setHeader) so this doesn't clobber express-session's own Set-Cookie header on
// the same response.
function persistCookie(res, locale) {
  res.append(
    "Set-Cookie",
    cookie.serialize(COOKIE_NAME, locale, { maxAge: COOKIE_MAX_AGE, sameSite: "lax", path: "/" })
  );
}

async function resolveLocale(req, res) {
  const queryLocale = req.query.lang;
  if (isSupportedLocale(queryLocale)) {
    persistCookie(res, queryLocale);
    if (req.user) {
      userPreferencesRepo
        .savePreferences(req.user.userId, { locale: queryLocale })
        .catch((err) => console.error("[i18n] Failed to persist locale preference:", err.message));
    }
    return queryLocale;
  }

  const cookies = cookie.parse(req.headers.cookie || "");
  if (isSupportedLocale(cookies[COOKIE_NAME])) return cookies[COOKIE_NAME];

  if (req.user) {
    const prefs = await userPreferencesRepo.getPreferences(req.user.userId);
    if (isSupportedLocale(prefs?.locale)) return prefs.locale;
  }

  // FIRST VISIT: nothing chosen, nothing saved. Detect the language, and - the part that was
  // missing - PERSIST it, so it becomes an actual choice instead of being re-derived from headers
  // on every single request. Without the write, a visitor whose browser stops sending
  // Accept-Language (or who is behind a proxy that strips it) silently flips to English mid-visit,
  // and there is no stored preference for the /settings page to show as current.
  const detected =
    localeFromAcceptLanguage(req.headers["accept-language"]) ||
    localeFromCountry(req.headers) ||
    DEFAULT_LOCALE;
  persistCookie(res, detected);

  // Logged in on their first visit (e.g. straight back from the OAuth callback)? Save it to the
  // account too, so the detection carries across browsers instead of living in one cookie.
  if (req.user) {
    userPreferencesRepo
      .savePreferences(req.user.userId, { locale: detected })
      .catch((err) => console.error("[i18n] Failed to persist detected locale:", err.message));
  }

  return detected;
}

async function i18nMiddleware(req, res, next) {
  let locale = DEFAULT_LOCALE;
  try {
    locale = await resolveLocale(req, res);
  } catch (err) {
    console.error("[i18n] Locale resolution failed, defaulting to en:", err.message);
  }

  req.locale = locale;
  res.locals.locale = locale;
  res.locals.t = (key, vars) => translate(locale, key, vars);
  res.locals.nativeLanguageNames = NATIVE_LANGUAGE_NAMES;

  if (isSupportedLocale(req.query.lang)) {
    const cleanQuery = { ...req.query };
    delete cleanQuery.lang;
    const qs = new URLSearchParams(cleanQuery).toString();
    return res.redirect(req.path + (qs ? `?${qs}` : ""));
  }

  next();
}

module.exports = i18nMiddleware;
// The /settings form saves the locale to UserPreferences, but the cookie outranks the saved
// preference in resolveLocale() above - so any save MUST also rewrite the cookie, or the old
// cookie keeps winning and the language never appears to change.
module.exports.persistLocaleCookie = persistCookie;
