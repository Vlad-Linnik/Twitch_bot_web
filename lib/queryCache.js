// Shared TTL + LRU cache for expensive read-only aggregations (word/emote clouds, leaderboards,
// per-user standing/heatmap/mentions). Extracted from wordStatsRepo.js's original inline
// implementation once a second and third repo needed the same shape - see config/statsLimits.js
// for why the numbers behind this exist (measured aggregation costs, not guesses).
//
// Each call site gets its OWN instance (own Map, own eviction budget) via createCache() rather
// than sharing one Map keyed across repos - that keeps a burst of, say, per-user cache churn from
// evicting the channel-wide leaderboard entry, and keeps key construction local to whichever repo
// owns the query.
function createCache({ ttlMs, maxEntries }) {
  const store = new Map();

  function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      store.delete(key);
      return null;
    }
    // Refresh LRU position so eviction below drops genuinely cold entries.
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }

  function set(key, value) {
    if (store.size >= maxEntries) {
      store.delete(store.keys().next().value); // oldest = least recently used
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  // Dedupes concurrent cache MISSES. get()/set() alone only help once one caller has already
  // populated the entry - if five people open the same channel page in the same instant, all
  // five see a miss and, without this, all five fire the same ~500ms aggregation at Mongo. This
  // is the actual fix for that: the first miss for a key starts load() and stashes the promise;
  // every other caller for that key within the same window awaits the SAME promise instead of
  // starting its own query, so a burst of simultaneous visitors costs exactly one query.
  const pending = new Map();

  async function cached(key, load) {
    const hit = get(key);
    if (hit !== null) return hit;

    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        const value = await load();
        set(key, value);
        return value;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, promise);
    return promise;
  }

  return { get, set, cached, _store: store }; // _store exposed for tests
}

module.exports = { createCache };
