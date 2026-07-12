// Pure locale detection, split out of middleware/i18n.js so it can be unit-tested without an
// Express request or a database (same reason lib/settingsValidation.js was extracted out of
// routes/settings.js - see CLAUDE.md, "Testing").
//
// Detection is only ever consulted on a visitor's FIRST request; after that the resolved locale
// is persisted (cookie, plus UserPreferences when logged in) and read back from there.
const { isSupportedLocale } = require("../config/i18n");

/**
 * Best supported locale from an Accept-Language header.
 *
 * Accept-Language is a q-weighted preference LIST ("ru-RU,ru;q=0.9,en-US;q=0.8"), not a single
 * value. Reading only the first entry is wrong the moment the top choice isn't one we support: a
 * browser sending "de,ru;q=0.9" prefers Russian over English explicitly, but a first-entry-only
 * reader sees "de", fails, and falls back to English. So walk the list in preference order.
 *
 * @returns {string|null} a supported locale, or null if none matched
 */
function localeFromAcceptLanguage(header) {
  if (!header) return null;

  const ranked = String(header)
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? parseFloat(qParam.split("=")[1]) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    // Stable sort by descending q - equal weights keep header order, which is the tie-break the
    // spec intends.
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0]; // "ru-RU" -> "ru"
    if (isSupportedLocale(base)) return base;
  }
  return null;
}

// Countries where Russian is the overwhelmingly likely UI preference. Kept deliberately short:
// this is a LAST-RESORT guess used only when the browser told us nothing, and guessing a language
// from a border is a much weaker signal than a user's own stated browser preference. Anything
// not listed simply falls through to the default locale.
const COUNTRY_LOCALE = { RU: "ru", BY: "ru", KZ: "ru" };

/**
 * Region fallback from a reverse proxy's country header.
 *
 * Deliberately NOT a GeoIP database. MaxMind & co. mean a ~70MB data file, a dependency, and a
 * monthly refresh chore - all to second-guess a signal (Accept-Language) the browser already
 * sends and which reflects what the user actually wants rather than where they happen to be. This
 * reads the country header a TLS-terminating proxy adds for free when one exists (Cloudflare's
 * CF-IPCountry is the usual case). No proxy => no header => no cost, we just use the default.
 *
 * @param {object} headers - req.headers
 * @returns {string|null}
 */
function localeFromCountry(headers = {}) {
  const country = headers["cf-ipcountry"] || headers["x-vercel-ip-country"];
  if (!country) return null;
  const locale = COUNTRY_LOCALE[String(country).toUpperCase()];
  return isSupportedLocale(locale) ? locale : null;
}

module.exports = { localeFromAcceptLanguage, localeFromCountry, COUNTRY_LOCALE };
