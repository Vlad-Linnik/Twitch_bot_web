// Answers "is this a real Twitch category?" for the custom-command form's per-category text rows
// (routes/customCommands.js's category-lookup endpoint). The browser never talks to Twitch: it asks
// us, we ask Helix with the site's app token (same client_credentials auth as gameBoxArt.js), and
// the answer is cached here so a mod retyping the same name, or several mods on one channel, cost
// one Helix call between them.
//
// Two calls, in order. Get Games by exact name first - one request, and the common case of a name
// typed or pasted correctly. Only when that misses do we run Search Categories: it finds the game
// when the casing differs (the bot compares lowercased, so "path of exile" is a genuine match) and
// its near misses become the "did you mean" list. What counts as a match is decided in
// lib/categoryLookup.js, which mirrors the bot's comparison.
//
// Found and not-found are cached for different lengths: a category that exists keeps existing, but
// one that does not may be created or renamed on Twitch's side, and a mod who just fixed a typo
// on Twitch's end should not be told "not found" for a day. Errors are never cached - an outage is
// reported as "unavailable" and the next keystroke tries again.
const axios = require("axios");
const env = require("../config/env");
const { ensureAppAccessToken } = require("./appToken");
const { createCache } = require("../lib/queryCache");
const { categoryKey, pickExactGame, buildLookupResult } = require("../lib/categoryLookup");

const GAMES_URL = "https://api.twitch.tv/helix/games";
const SEARCH_URL = "https://api.twitch.tv/helix/search/categories";
const SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 5000;

const foundCache = createCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 2000 });
const missingCache = createCache({ ttlMs: 15 * 60 * 1000, maxEntries: 2000 });
const pending = new Map(); // key -> Promise, so a burst of identical misses costs one Helix round

async function helixGet(url, params) {
  const response = await axios.get(url, {
    params,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      "Client-Id": env.twitchClientId,
    },
  });
  return Array.isArray(response.data?.data) ? response.data.data : [];
}

async function resolve(name) {
  const exactFromGames = pickExactGame(await helixGet(GAMES_URL, { name }), name);
  if (exactFromGames) return buildLookupResult(name, exactFromGames, []);
  const searchResults = await helixGet(SEARCH_URL, { query: name, first: SEARCH_LIMIT });
  return buildLookupResult(name, pickExactGame(searchResults, name), searchResults);
}

// `name` must already be validated by lib/categoryLookup.js's parseCategoryQuery. Throws on a Helix
// failure (the route turns that into "unavailable").
async function lookupCategory(name) {
  const key = categoryKey(name);
  const hit = foundCache.get(key) || missingCache.get(key);
  if (hit) return hit;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const result = await resolve(name);
      (result.status === "found" ? foundCache : missingCache).set(key, result);
      return result;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, promise);
  return promise;
}

module.exports = { lookupCategory };
