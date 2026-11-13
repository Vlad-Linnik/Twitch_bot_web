// The search behind a movie card's form: which sources exist, a reference format that names one
// result, and a small cache in front of all of them.
//
// Two tabs:
//   - "films"  - films and series. TMDB when TMDB_READ_TOKEN is set; without it, the IMDb
//                suggestion endpoint (+ Wikidata for the Russian title). One or the other, never
//                both: the editor sees one list, not two that disagree.
//   - "anime"  - Shikimori, always (no key).
//
// A result is named by a `ref` - "tmdb:movie:27205", "tmdb:tv:1396", "shikimori:16498",
// "imdb:tt1375666". The form carries only that string back; when the card is saved the server asks
// the source for the details again itself, and the poster it downloads is the one in THAT answer.
// A poster URL is never taken from the form - that would let anyone point our server at any address.
//
// Every failure reads as "nothing found" plus `unavailable: true`: these are other people's
// services, one of them undocumented, and manual entry always remains.
const { createTmdbSource } = require("./tmdb");
const { createShikimoriSource } = require("./shikimori");
const { createImdbSuggestSource } = require("./imdbSuggest");
const { createSteamSource } = require("./steam");
const { createTwitchCategorySource } = require("./twitchCategories");
const { isAllowedMediaImageUrl } = require("../mediaImageHosts");

// The film section's tabs (games have their own - see createGameSources).
const TABS = ["films", "anime"];
const SEARCH_TTL_MS = 60 * 60 * 1000;
const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const QUERY_MIN = 2;
const QUERY_MAX = 100;

const REF_PATTERNS = {
  tmdb: /^tmdb:((?:movie|tv):\d{1,10})$/,
  shikimori: /^shikimori:(\d{1,9})$/,
  imdb: /^imdb:(tt\d{7,10})$/,
  steam: /^steam:(\d{1,9})$/,
  twitch: /^twitch:(\d{1,12})$/,
};

// {source, id} for a well-formed ref, or null. The id format is checked again by each source.
function parseRef(ref) {
  if (typeof ref !== "string" || ref.length > 40) return null;
  for (const [source, pattern] of Object.entries(REF_PATTERNS)) {
    const m = ref.match(pattern);
    if (m) return { source, id: m[1] };
  }
  return null;
}

function normalizeQuery(q) {
  const s = typeof q === "string" ? q.replace(/\s+/g, " ").trim() : "";
  return s.length >= QUERY_MIN ? s.slice(0, QUERY_MAX) : null;
}

// Insertion-ordered Map as an LRU-ish cache: a hit re-inserts, the oldest entry goes first.
function createCache({ max = CACHE_MAX, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, ttl) {
      map.delete(key);
      map.set(key, { value, expires: now() + ttl });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

// A registry over some sources: `tabs` maps each tab of the search box to the source behind it,
// `sources` names every source a ref may point at. Search results and details are cached, failures
// read as "nothing found" + unavailable and are logged once per source and kind.
function createSourceRegistry({ tabs, sources, cache = createCache(), log = console }) {
  const tabKeys = Object.keys(tabs);
  // One warning per source per kind of failure until it recovers - not one per keystroke.
  const warned = new Set();

  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    cache.set(key, value, ttl);
    return value;
  }

  function report(source, err) {
    const tag = `${source}:${err.code || err.name}`;
    if (warned.has(tag)) return;
    warned.add(tag);
    log.warn(`[mediaSources] ${source} unavailable: ${err.code || err.name}`);
  }

  // Previews are someone else's pictures shown before saving; only hosts on the CSP list survive.
  const safePreview = (r) => ({ ...r, previewUrl: isAllowedMediaImageUrl(r.previewUrl) ? r.previewUrl : null });

  return {
    TABS: tabKeys,
    // What the editor's tabs say about where the results come from.
    describe() {
      return Object.fromEntries(tabKeys.map((tab) => [tab, tabs[tab].key]));
    },
    async search(tab, rawQuery) {
      const query = normalizeQuery(rawQuery);
      if (!tabKeys.includes(tab) || !query) return { results: [] };
      const source = tabs[tab];
      try {
        const results = await cached(`s:${source.key}:${query.toLowerCase()}`, SEARCH_TTL_MS, () => source.search(query));
        warned.delete(`${source.key}:search`);
        return { source: source.key, results: results.map(safePreview) };
      } catch (err) {
        report(source.key, err);
        return { source: source.key, results: [], unavailable: true };
      }
    },
    // Details for one ref, or null (bad ref, source off, not found, unavailable).
    async details(ref) {
      const parsed = parseRef(ref);
      if (!parsed) return null;
      const source = sources[parsed.source];
      if (!source) return null;
      try {
        const d = await cached(`d:${ref}`, DETAILS_TTL_MS, () => source.details(parsed.id));
        if (!d) return null;
        return {
          ...safePreview(d),
          posterUrl: isAllowedMediaImageUrl(d.posterUrl) ? d.posterUrl : null,
          posterFallbackUrl: isAllowedMediaImageUrl(d.posterFallbackUrl) ? d.posterFallbackUrl : null,
        };
      } catch (err) {
        report(source.key, err);
        return null;
      }
    },
  };
}

// Films: TMDB when its token is set, else the no-key IMDb suggestion search; Shikimori for anime.
function createMediaSources({ tmdbToken = null, fetchImpl, cache, log } = {}) {
  const sources = {
    tmdb: tmdbToken ? createTmdbSource({ token: tmdbToken, fetchImpl }) : null,
    shikimori: createShikimoriSource({ fetchImpl }),
    imdb: createImdbSuggestSource({ fetchImpl }),
  };
  return createSourceRegistry({
    tabs: { films: sources.tmdb || sources.imdb, anime: sources.shikimori },
    sources,
    cache,
    log,
  });
}

// Games: Twitch's own categories first - it is the name the game was streamed under, which is what
// ties a card to its hours on stream - and Steam for the store link, the art and the review score.
// `twitch` = {getToken, clientId}: the site's app token (twitch/appToken.js); without a client id
// the Twitch tab simply finds nothing.
function createGameSources({ twitch = {}, fetchImpl, cache, log } = {}) {
  const sources = {
    twitch: createTwitchCategorySource({ ...twitch, fetchImpl }),
    steam: createSteamSource({ fetchImpl }),
  };
  return createSourceRegistry({ tabs: { twitch: sources.twitch, steam: sources.steam }, sources, cache, log });
}

module.exports = { createMediaSources, createGameSources, createSourceRegistry, createCache, parseRef, normalizeQuery, TABS };
