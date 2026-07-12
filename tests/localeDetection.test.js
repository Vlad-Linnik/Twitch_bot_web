const test = require("node:test");
const assert = require("node:assert/strict");
const { localeFromAcceptLanguage, localeFromCountry } = require("../lib/localeDetection");

test("picks the language from a simple header", () => {
  assert.equal(localeFromAcceptLanguage("ru"), "ru");
  assert.equal(localeFromAcceptLanguage("en-US"), "en");
});

test("strips the region subtag", () => {
  assert.equal(localeFromAcceptLanguage("ru-RU,ru;q=0.9"), "ru");
});

test("honours q-weights instead of blindly taking the first entry", () => {
  // The bug this guards: the old implementation read only the FIRST entry. A browser sending
  // "de,ru;q=0.9" states a clear preference for Russian over English, but first-entry-only sees
  // an unsupported "de", gives up, and silently serves English.
  assert.equal(localeFromAcceptLanguage("de,ru;q=0.9"), "ru");
  assert.equal(localeFromAcceptLanguage("fr-CA,fr;q=0.9,en;q=0.8,ru;q=0.7"), "en");
  // Explicitly lower-weighted English must lose to higher-weighted Russian.
  assert.equal(localeFromAcceptLanguage("en;q=0.5,ru;q=0.9"), "ru");
});

test("ignores entries with q=0 (an explicit refusal)", () => {
  assert.equal(localeFromAcceptLanguage("en;q=0,ru;q=0.5"), "ru");
});

test("returns null when nothing is supported, so the caller can fall back", () => {
  assert.equal(localeFromAcceptLanguage("de,fr;q=0.9"), null);
  assert.equal(localeFromAcceptLanguage(""), null);
  assert.equal(localeFromAcceptLanguage(undefined), null);
});

test("country header maps to a locale only for known countries", () => {
  assert.equal(localeFromCountry({ "cf-ipcountry": "RU" }), "ru");
  assert.equal(localeFromCountry({ "cf-ipcountry": "by" }), "ru"); // case-insensitive
  assert.equal(localeFromCountry({ "x-vercel-ip-country": "KZ" }), "ru");
});

test("country header falls through when there is no proxy or no mapping", () => {
  assert.equal(localeFromCountry({}), null);
  assert.equal(localeFromCountry({ "cf-ipcountry": "DE" }), null);
  // Cloudflare sends XX for anonymised/unknown IPs - must not be treated as a country.
  assert.equal(localeFromCountry({ "cf-ipcountry": "XX" }), null);
});
