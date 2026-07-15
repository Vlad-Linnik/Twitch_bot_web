// Word + emote clouds, for both the channel statistics page (/<channel>/statistics/chat) and the
// user dashboard (/<channel>/user/<name>).
//
// Four clouds, and they are NOT the same query - the difference is the whole design:
//
//   CHANNEL word cloud  -> ChatWordStats, precomputed by the bot. Fully covered by the
//                          {channel, date, count, word} index (0 document fetches). `all` is a
//                          top-N index scan (~1ms); a range still has to $group ~72k distinct
//                          words (~495ms), which is why results are cached.
//   CHANNEL emote cloud -> WordLifetimeStats / `words`, which despite their names hold ONLY
//                          whitelisted (7TV) emotes, not words. Tiny (~500 rows). Free.
//   USER word/emote     -> no precomputed source exists ({user x word x day} would explode in
//                          cardinality), so these tokenize that user's raw `messages` on the
//                          fly. Bounded by the {channel, userId, timestamp} index and by
//                          MAX_USER_MESSAGES_SCANNED. Both clouds come from ONE pass.
//
// Channel-field convention: `messages`, `words`, `WordLifetimeStats` and the new ChatWordStats
// all store `channel` WITH a leading "#". statsRepo.js documents the wider inconsistency.
const { connect } = require("./connection");
const { extractWords, LIFETIME_BUCKET } = require("../lib/textStats");
const limits = require("../config/statsLimits");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    chatWordStats: db.collection("ChatWordStats"),
    wordLifetimeStats: db.collection("WordLifetimeStats"), // tracked emotes, all-time
    words: db.collection("words"), // tracked emotes, per-day
    messages: db.collection("messages"),
    whiteList: db.collection("whiteList"),
    // Bot-written tombstones for emotes whose words/WordLifetimeStats rows were pruned after
    // un-tracking - the third member of the emote-exclusion union in getUserClouds().
    emoteExclusions: db.collection("EmoteExclusions"),
  };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

// periodStart moved to config/statsLimits.js - statsRepo's period-switchable reads need the
// identical window computation, and there it's unit-testable without Mongo.
const { periodStart } = limits;

// ---------------------------------------------------------------------------------------
// Cache. The month-range $group is ~495ms even fully covered; without this, two viewers on the
// channel page would serialize half-second aggregations on a 2GB box. A cloud is not real-time
// data - nobody can distinguish a 10-minute-old word cloud from a live one.
// ---------------------------------------------------------------------------------------
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU position so the eviction below drops genuinely cold entries.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= limits.CLOUD_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value); // oldest = least recently used
  }
  cache.set(key, { value, expiresAt: Date.now() + limits.CLOUD_CACHE_TTL_MS });
  return value;
}

// ---------------------------------------------------------------------------------------
// Channel clouds
// ---------------------------------------------------------------------------------------

async function getChannelWordCloud(channelLogin, requestedPeriod, requestedLimit) {
  const period = limits.resolvePeriod(requestedPeriod, { max: limits.MAX_CLOUD_PERIOD });
  const limit = limits.clampLimit(requestedLimit, limits.DEFAULT_CLOUD_WORDS, limits.MAX_CLOUD_WORDS);
  const channel = withHash(channelLogin);

  const key = `word:${channel}:${period}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { chatWordStats } = await ensureInitialized();
  const start = periodStart(period);

  let rows;
  if (start === null) {
    // All-time: the bot maintains a precomputed row per word at the epoch sentinel date, so this
    // is a covered top-N index scan - no $group, no document fetches.
    rows = await chatWordStats
      .find({ channel, date: LIFETIME_BUCKET })
      .sort({ count: -1 })
      .limit(limit)
      .project({ _id: 0, word: 1, count: 1 })
      .toArray();
  } else {
    // Range: $gte start already excludes the epoch row (1970 < any real window), so the all-time
    // total can never be double-counted into a range.
    const grouped = await chatWordStats
      .aggregate(
        [
          { $match: { channel, date: { $gte: start } } },
          { $group: { _id: "$word", count: { $sum: "$count" } } },
          { $sort: { count: -1 } },
          { $limit: limit },
          { $project: { _id: 0, word: "$_id", count: 1 } },
        ],
        { allowDiskUse: false } // fail loudly rather than silently spilling to disk on the VPS
      )
      .toArray();
    rows = grouped;
  }

  return cacheSet(key, { period, words: rows });
}

// Tracked (7TV) emotes. NOTE: a channel that has never had its 7TV emote set synced has an empty
// whiteList, and therefore an empty emote cloud - that is a data gap, not a bug. As of writing,
// #mistercop has 0 tracked emotes while #vlad_261 has 102.
async function getChannelEmoteCloud(channelLogin, requestedPeriod, requestedLimit) {
  const period = limits.resolvePeriod(requestedPeriod, { max: limits.MAX_CLOUD_PERIOD });
  const limit = limits.clampLimit(requestedLimit, limits.DEFAULT_LEADERBOARD, limits.MAX_CLOUD_WORDS);
  const channel = withHash(channelLogin);

  const key = `emote:${channel}:${period}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { wordLifetimeStats, words } = await ensureInitialized();
  const start = periodStart(period);

  let rows;
  if (start === null) {
    rows = await wordLifetimeStats
      .find({ channel })
      .sort({ count: -1 })
      .limit(limit)
      .project({ _id: 0, word: 1, count: 1 })
      .toArray();
  } else {
    rows = await words
      .aggregate(
        [
          { $match: { channel, date: { $gte: start } } },
          { $group: { _id: "$word", count: { $sum: "$count" } } },
          { $sort: { count: -1 } },
          { $limit: limit },
          { $project: { _id: 0, word: "$_id", count: 1 } },
        ],
        { allowDiskUse: false }
      )
      .toArray();
  }

  return cacheSet(key, { period, emotes: rows });
}

// Size of the channel's whiteList - every emote the bot is currently configured to track (7TV
// set + Twitch global), whether or not it's been typed in chat yet. NOT the same as
// getChannelEmoteCloud(...).emotes.length (capped at whatever leaderboard limit the caller
// passed, 10 on the channel dashboard) or WordLifetimeStats.countDocuments() (usage: only
// emotes actually seen at least once - always <= whiteList size, since a newly-synced global
// emote nobody has typed yet has no WordLifetimeStats row). whiteList is small, so this is cheap.
async function getTrackedEmoteCount(channelLogin) {
  const { whiteList } = await ensureInitialized();
  const channel = withHash(channelLogin);
  return whiteList.countDocuments({ channel });
}

// ---------------------------------------------------------------------------------------
// Per-user clouds - one pass over that user's messages produces both.
// ---------------------------------------------------------------------------------------

async function getUserClouds(channelLogin, userId, requestedPeriod, requestedLimit) {
  const period = limits.resolvePeriod(requestedPeriod);
  const limit = limits.clampLimit(requestedLimit, limits.DEFAULT_CLOUD_WORDS, limits.MAX_CLOUD_WORDS);
  const channel = withHash(channelLogin);

  const key = `user:${channel}:${userId}:${period}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const { messages, whiteList, wordLifetimeStats, emoteExclusions } = await ensureInitialized();

  // Two DIFFERENT emote sets, and the difference is the contract with the channel-wide clouds:
  //
  //   EXCLUSION (emoteSet) - emotes the channel tracks now (whiteList) UNION emotes it has ever
  //   tracked (WordLifetimeStats + the bot's EmoteExclusions tombstones, which survive the bot
  //   pruning un-tracked emotes' rows). Mirrors the bot's ChatStats.emoteExclusionCache; matched
  //   case-insensitively. Without the union, un-tracked emotes reappear in the WORD cloud as
  //   fake "words".
  //
  //   DISPLAY (trackedCanonical) - CURRENTLY tracked emotes only, lowercased token -> canonical
  //   whiteList name. The user's emote cloud must show the same population the channel's Top
  //   emotes can show (WordLifetimeStats holds only tracked emotes after pruning) - counting the
  //   whole union here used to surface long-removed emotes that exist nowhere on the channel
  //   page. Canonical casing also makes counts merge across "AROLF"/"arolf" as typed AND lets
  //   the emote-image join resolve (the 7TV/Helix image map is keyed by canonical names).
  //
  // A token in the union but NOT currently tracked lands in NEITHER cloud - exactly like the
  // channel pages, where pruning removes an emote from the emote cloud without letting it back
  // into the word cloud.
  const [current, historical, tombstones] = await Promise.all([
    whiteList.find({ channel }, { projection: { word: 1 } }).toArray(),
    wordLifetimeStats.find({ channel }, { projection: { word: 1 } }).toArray(),
    emoteExclusions.find({ channel }, { projection: { word: 1 } }).toArray(),
  ]);
  const emoteSet = new Set(
    [...current, ...historical, ...tombstones].map((w) => String(w.word).toLowerCase())
  );
  const isEmote = (token) => emoteSet.has(String(token).toLowerCase());
  const trackedCanonical = new Map(current.map((w) => [String(w.word).toLowerCase(), String(w.word)]));

  const query = { channel, userId: String(userId) };
  const start = periodStart(period);
  if (start !== null) query.timestamp = { $gte: start };

  // Newest-first + capped: a top chatter can have six figures of messages, and this is the one
  // read path with no precomputed collection behind it. Uses {channel, userId, timestamp}.
  const cursor = messages
    .find(query, { projection: { _id: 0, message: 1 } })
    .sort({ timestamp: -1 })
    .limit(limits.MAX_USER_MESSAGES_SCANNED)
    .batchSize(1000);

  const wordFreq = new Map();
  const emoteFreq = new Map();
  let scanned = 0;

  for await (const doc of cursor) {
    scanned++;
    // extractWords already drops commands, stopwords, URLs and emotes; emotes are counted
    // separately below so the two clouds stay disjoint, exactly as they are channel-wide.
    for (const word of extractWords(doc.message, isEmote)) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
    if (trackedCanonical.size > 0) {
      // Dedupe per message on the CANONICAL name (not the raw token), so "4head 4Head" in one
      // message counts once - same message-presence semantics the raw-token Set always had.
      const seenCanonical = new Set();
      for (const token of String(doc.message || "").trim().split(/\s+/)) {
        const canonical = trackedCanonical.get(String(token).toLowerCase());
        if (canonical) seenCanonical.add(canonical);
      }
      for (const canonical of seenCanonical) {
        emoteFreq.set(canonical, (emoteFreq.get(canonical) || 0) + 1);
      }
    }
  }

  const topN = (freq) =>
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));

  return cacheSet(key, {
    period,
    words: topN(wordFreq),
    emotes: topN(emoteFreq),
    scanned,
    // True when the cap bit: the cloud reflects the most recent MAX_USER_MESSAGES_SCANNED
    // messages in the period rather than all of them. The UI should say so rather than imply
    // completeness.
    sampled: scanned >= limits.MAX_USER_MESSAGES_SCANNED,
  });
}

module.exports = {
  getChannelWordCloud,
  getChannelEmoteCloud,
  getTrackedEmoteCount,
  getUserClouds,
  periodStart,
  _cache: cache, // exposed for tests
};
