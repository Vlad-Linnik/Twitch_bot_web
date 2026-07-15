// Every hard limit protecting the 2GB production VPS, in one auditable place.
//
// These are not arbitrary. They were set against the real dataset (~1.9M messages in
// `messages`, ~2.2M rows in `ChatWordStats`) by measuring the actual queries with
// explain("executionStats"):
//
//   channel word cloud, period=all    ->     100 index keys, 0 docs fetched,   ~1ms  (covered)
//   channel word cloud, period=month  -> 190,326 index keys, 0 docs fetched, ~495ms  (covered)
//
// The month query is fully covered by ChatWordStats' {channel, date, count, word} index and
// still costs ~half a second, because it has to $group ~72k distinct words. That is fine once
// per cache window and far too expensive per request - which is why CLOUD_CACHE_TTL_MS below
// is load-bearing, not a nicety. Raising MAX_CLOUD_PERIOD without re-measuring is the single
// easiest way to take the VPS down.
//
// A route must never accept a caller-supplied period/limit directly; it passes it through
// resolvePeriod()/clampLimit() first so an attacker cannot ask for "all messages, ungrouped".

// Named periods, mirroring the bot's own ChatStats.selectPeriod() vocabulary so both repos
// speak the same language. `all` is special: it reads the precomputed all-time row rather than
// aggregating any range, so it is the CHEAPEST option, not the most expensive one.
const PERIODS = ["day", "week", "month", "all"];
const DEFAULT_PERIOD = "week";

// The channel-wide clouds aggregate across every chatter, so they get the tightest leash.
// `month` is the widest range we have measured as survivable; anything wider must go through
// the precomputed all-time row instead.
const MAX_CLOUD_PERIOD = "month";

// GitHub-style contribution calendar. Capped at 5 months per the product spec - it also keeps
// the per-user $group bounded to ~150 day-buckets.
const MAX_HEATMAP_DAYS = 155;

// Per-user clouds have no precomputed collection behind them (a {user x word x day} index would
// explode in cardinality), so they aggregate raw `messages` on the fly, using the
// {channel, userId, timestamp} index. That is bounded per user, but a top chatter can still
// have six figures of messages - so the scan itself is capped. Past this many messages the
// cloud is built from the most recent N in the period and flagged `sampled: true`, so the UI
// can say so rather than quietly lying.
const MAX_USER_MESSAGES_SCANNED = 20000;

// Result-set sizes.
const DEFAULT_CLOUD_WORDS = 100;
const MAX_CLOUD_WORDS = 200;
const DEFAULT_LEADERBOARD = 10;
const MAX_LEADERBOARD = 100;

// The image-based emote cloud on /<channel>/statistics/chat. Cheap regardless of period:
// the all-time read is WordLifetimeStats (~500 rows/channel) and ranges group the small
// `words` collection, not ChatWordStats.
const EMOTE_CLOUD_SIZE = 40;

// Log search: the search is only affordable because the {channel, userId, timestamp} index
// narrows the candidate set BEFORE any text matching happens. Channel is therefore always
// mandatory, and the result set is hard-capped.
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_USERS = 25; // multi-user filter ($in) width
const MAX_SEARCH_TERM_LENGTH = 100;

// Fuzzy (typo-tolerant) search cannot use an index - it has to look at each candidate message in
// Node. That is perfectly affordable on a narrow set (one user, one week) and ruinous on a wide
// one (a whole channel, a whole year). So it is allowed only when the indexed filter has already
// cut the candidates below this; above it, searchRepo refuses fuzzy, runs the exact search
// instead, and returns fuzzyRefusedReason so the UI can tell the moderator to narrow the filter.
// ~30k docs x ~172B is a few MB of scanning - comfortably inside the budget.
const MAX_SEARCH_FUZZY_CANDIDATES = 30000;

// How long a computed cloud/leaderboard is reused. Word clouds are not real-time data; nobody
// can tell a 10-minute-old cloud from a live one, and it converts the ~495ms month query from
// a per-request cost into a per-10-minutes cost.
const CLOUD_CACHE_TTL_MS = 10 * 60 * 1000;

// Guards the cache itself from becoming the memory leak it exists to prevent. Keys are
// {channel, period, kind}, so this bounds us to a few hundred KB.
const CLOUD_CACHE_MAX_ENTRIES = 200;

// Start of the window for a named period, bucketed the same way the bot buckets its daily rows
// (textStats.dayBucket). Returns null for `all`, which is a signal to read the precomputed
// all-time row instead of scanning any range at all. Lives here (not in a repo) because every
// period-switchable read path - clouds, top chatters, moderator summary - needs the same window.
const { dayBucket } = require("../lib/textStats");

function periodStart(period) {
  if (period === "all") return null;
  // 'day' means the current calendar day, not a rolling 24h window: chatStats.js buckets every
  // row's `date` field to dayBucket(the message's own timestamp), so "today" is exactly
  // dayBucket(now) - anything else would pull in part of yesterday's bucket too.
  if (period === "day") return dayBucket(new Date());
  const days = { week: 7, month: 30 }[period] ?? 7;
  return dayBucket(new Date(Date.now() - days * 86400000));
}

function resolvePeriod(requested, { max = null } = {}) {
  const period = PERIODS.includes(requested) ? requested : DEFAULT_PERIOD;
  if (!max) return period;
  // `all` is cheaper than any range (precomputed row), so a max never downgrades it.
  if (period === "all") return period;
  const rank = (p) => PERIODS.indexOf(p);
  return rank(period) > rank(max) ? max : period;
}

function clampLimit(requested, fallback, max) {
  const n = parseInt(requested, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

module.exports = {
  PERIODS,
  DEFAULT_PERIOD,
  MAX_CLOUD_PERIOD,
  MAX_HEATMAP_DAYS,
  MAX_USER_MESSAGES_SCANNED,
  DEFAULT_CLOUD_WORDS,
  MAX_CLOUD_WORDS,
  DEFAULT_LEADERBOARD,
  MAX_LEADERBOARD,
  EMOTE_CLOUD_SIZE,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_USERS,
  MAX_SEARCH_TERM_LENGTH,
  MAX_SEARCH_FUZZY_CANDIDATES,
  CLOUD_CACHE_TTL_MS,
  CLOUD_CACHE_MAX_ENTRIES,
  resolvePeriod,
  clampLimit,
  periodStart,
};
