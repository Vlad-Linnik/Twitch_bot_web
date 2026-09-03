// Candidate pools for the "Выше — ниже" game, read out of the bot-owned stat collections.
//
// Read-only, and deliberately a module of its own rather than more functions on wordStatsRepo.js:
// that one answers "what does this channel say most" for the dashboards (top-N, capped at 100-200
// rows), while this one answers "what may the game draw from" (thousands of rows, no ordering,
// its own thresholds). Same collections, different contract - and mixing them would make the
// clouds' tight result caps look negotiable.
//
// Channel key convention: ChatWordStats / WordLifetimeStats / words all store `channel` WITH a
// leading "#", same as everywhere else in this repo (see db/statsRepo.js on the wider mess).
const { connect } = require("./connection");
const { LIFETIME_BUCKET } = require("../lib/textStats");
const limits = require("../config/statsLimits");
const { createCache } = require("../lib/queryCache");
const votesRepo = require("./higherLowerVotesRepo");
const hl = require("../lib/higherLower");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    chatWordStats: db.collection("ChatWordStats"), // the real word index
    wordLifetimeStats: db.collection("WordLifetimeStats"), // emotes, all-time
    words: db.collection("words"), // emotes, per day
  };
  return collections;
}

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

// A pool is re-read on every answer (the run document stores only the current pair, not the
// thousands of rows behind it), so this TTL is what keeps a mid-run answer from paying for an
// aggregation. It is longer than the dashboards' 10 minutes on purpose: the month pool costs
// ~930ms against production and a run outlives a cloud's refresh window. Pools also move slowly -
// a word crossing the threshold mid-run changes nothing a player can perceive. The single-flight
// dedupe inside queryCache is what stops a burst of answers from firing concurrent rebuilds.
const POOL_TTL_MS = 30 * 60 * 1000;

const { cached: withCache } = createCache({
  ttlMs: POOL_TTL_MS,
  maxEntries: limits.STATS_CACHE_MAX_ENTRIES,
});

// ---------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------

// One $group over the month window, shared by the word and emote month reads - only the
// collection and the threshold differ.
async function groupedSince(collection, channel, start, min) {
  return collection
    .aggregate(
      [
        { $match: { channel, date: { $gte: start } } },
        { $group: { _id: "$word", count: { $sum: "$count" } } },
        { $match: { count: { $gte: min } } },
        { $project: { _id: 0, word: "$_id", count: 1 } },
      ],
      { allowDiskUse: false } // fail loudly rather than spilling to disk on the VPS
    )
    .toArray();
}

// Every token the game may draw for this channel/mode/period, as [{word, count}].
async function getPool(channelLogin, mode, period) {
  const channel = withHash(channelLogin);
  const min = hl.minCount(mode, period);

  return withCache(`pool:${mode}:${period}:${channel}`, async () => {
    const { chatWordStats, wordLifetimeStats, words } = await ensureInitialized();
    const start = limits.periodStart(period);

    if (mode === "emotes") {
      if (start === null) {
        return wordLifetimeStats
          .find({ channel, count: { $gte: min } })
          .project({ _id: 0, word: 1, count: 1 })
          .toArray();
      }
      return groupedSince(words, channel, start, min);
    }

    if (start === null) {
      // Covered by ChatWordStats' {channel, date, count, word} index - no document fetches even
      // at 7.5k rows, because every field asked for is in the key.
      return chatWordStats
        .find({ channel, date: LIFETIME_BUCKET, count: { $gte: min } })
        .project({ _id: 0, word: 1, count: 1 })
        .toArray();
    }
    // $gte start already excludes the epoch sentinel row, so the all-time total can never be
    // folded into a range.
    return groupedSince(chatWordStats, channel, start, min);
  });
}

// ---------------------------------------------------------------------------------------
// Which channels are offered at all
// ---------------------------------------------------------------------------------------

// Size only - the picker needs a number, not the rows, and for the all-time periods this is a
// pure index count. Cached under its own key so opening the start screen doesn't drag a full
// pool into memory for every channel on the site.
async function getPoolSize(channelLogin, mode, period) {
  const channel = withHash(channelLogin);
  const min = hl.minCount(mode, period);

  return withCache(`size:${mode}:${period}:${channel}`, async () => {
    const { chatWordStats, wordLifetimeStats, words } = await ensureInitialized();
    const start = limits.periodStart(period);

    if (mode === "emotes") {
      if (start === null) return wordLifetimeStats.countDocuments({ channel, count: { $gte: min } });
      return (await groupedSince(words, channel, start, min)).length;
    }
    if (start === null) {
      return chatWordStats.countDocuments({ channel, date: LIFETIME_BUCKET, count: { $gte: min } });
    }
    return (await groupedSince(chatWordStats, channel, start, min)).length;
  });
}

// The channels worth offering for this mode/period, largest pool first. A channel whose chat is
// too thin is left out entirely rather than offered and then failing - see MIN_CHANNEL_POOL.
async function listPlayableChannels(channels, mode, period) {
  const sizes = await Promise.all(
    channels.map((c) => getPoolSize(c.channelLogin, mode, period).catch(() => 0))
  );
  return channels
    .map((c, i) => ({ channelLogin: c.channelLogin, channelId: c.channelId, poolSize: sizes[i] }))
    .filter((c) => hl.isChannelPlayable(mode, c.poolSize))
    .sort((a, b) => b.poolSize - a.poolSize);
}

// ---------------------------------------------------------------------------------------
// Player votes, cached separately from the pool
// ---------------------------------------------------------------------------------------

// Short, because this is the one thing on this page a player changes by hand and then expects to
// see working. It is kept out of the pool cache above deliberately: that one holds thousands of
// rows and costs ~930ms to rebuild, and dropping it on every thumb press would make voting the
// most expensive action in the game. The scores map holds only words somebody has actually rated.
const VOTE_TTL_MS = 60 * 1000;

const { cached: withVoteCache } = createCache({ ttlMs: VOTE_TTL_MS, maxEntries: 100 });

async function getVoteScores(channelLogin) {
  return withVoteCache(`votes:${channelLogin}`, () => votesRepo.getScores(channelLogin));
}

// Just the word -> net-score map the sampler needs.
async function getWordVoteMap(channelLogin) {
  const scores = await getVoteScores(channelLogin);
  const map = new Map();
  for (const [word, s] of scores) if (s.wordNet !== 0) map.set(word, s.wordNet);
  return map;
}

module.exports = { getPool, getPoolSize, listPlayableChannels, getVoteScores, getWordVoteMap, POOL_TTL_MS, VOTE_TTL_MS };
