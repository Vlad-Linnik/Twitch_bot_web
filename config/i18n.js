// Minimal in-repo i18n - flat JSON dictionaries keyed by dotted path, no
// external i18n library (matches this repo's convention of small hand-rolled
// modules over dependencies, e.g. middleware/csrf.js).
const en = require("./locales/en.json");
const ru = require("./locales/ru.json");

const DEFAULT_LOCALE = "en";
const SUPPORTED_LOCALES = ["en", "ru"];
const dictionaries = { en, ru };

// Each language's own name for itself, not run through translate() - a
// language option should always read in its own language regardless of the
// UI's current locale (e.g. "Русский" stays "Русский" when browsing in English).
const NATIVE_LANGUAGE_NAMES = { en: "English", ru: "Русский" };

function isSupportedLocale(locale) {
  return SUPPORTED_LOCALES.includes(locale);
}

function resolveKey(dict, key) {
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), dict);
}

// {{name}} placeholders, filled in from `vars` - only the settings-change-log sentences
// (lib/settingsChangeDescribe.js) need this so far; every other call site just omits `vars`.
function interpolate(text, vars) {
  if (!vars || typeof text !== "string") return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Falls back to the English string, then to the raw key itself, so a missing
// translation never breaks rendering - it just shows untranslated text.
function translate(locale, key, vars) {
  const value = resolveKey(dictionaries[locale] || dictionaries[DEFAULT_LOCALE], key);
  if (value !== undefined) return interpolate(value, vars);
  const fallback = resolveKey(dictionaries[DEFAULT_LOCALE], key);
  if (fallback !== undefined) return interpolate(fallback, vars);
  console.warn(`[i18n] Missing translation key: ${key}`);
  return key;
}

module.exports = { translate, isSupportedLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES, NATIVE_LANGUAGE_NAMES };
