// Locale resolution: ?lang= query param (persists via cookie + redirects to
// the clean URL) > "lang" cookie > saved account preference (if logged in) >
// Accept-Language header > default "en". Exposes res.locals.t()/res.locals.locale
// to every view. Mounted after middleware/auth.js (needs req.user) and after
// middleware/session.js (uses the "cookie" package directly - already a
// transitive dep of express-session - since there's no cookie-parser mounted).
const cookie = require("cookie");
const { translate, isSupportedLocale, DEFAULT_LOCALE, NATIVE_LANGUAGE_NAMES } = require("../config/i18n");
const userPreferencesRepo = require("../db/userPreferencesRepo");

const COOKIE_NAME = "lang";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year, seconds

function localeFromAcceptLanguage(header) {
  if (!header) return null;
  const primary = header.split(",")[0]?.split("-")[0]?.trim().toLowerCase();
  return isSupportedLocale(primary) ? primary : null;
}

async function resolveLocale(req, res) {
  const queryLocale = req.query.lang;
  if (isSupportedLocale(queryLocale)) {
    // res.append (not setHeader) so this doesn't clobber express-session's own
    // Set-Cookie header on the same response.
    res.append(
      "Set-Cookie",
      cookie.serialize(COOKIE_NAME, queryLocale, { maxAge: COOKIE_MAX_AGE, sameSite: "lax", path: "/" })
    );
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

  return localeFromAcceptLanguage(req.headers["accept-language"]) || DEFAULT_LOCALE;
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
  res.locals.t = (key) => translate(locale, key);
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
