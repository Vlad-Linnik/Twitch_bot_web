// Everything behind /<channel>/user/<username>: identity + nickname history, the message-count
// chart (the visual equivalent of the bot's !countmsg), the GitHub-style activity heatmap, and
// the @mention tracker.
//
// All of these are per-user, which is what makes them affordable: they filter on
// {channel, userId} first and only then range over time, so they ride the
// {channel, userId, timestamp} index added to `messages` for exactly this purpose. A single
// user's history is a tight index range even though the collection has ~1.9M rows.
const { connect } = require("./connection");
const { dayBucket, LIFETIME_BUCKET } = require("../lib/textStats");
const limits = require("../config/statsLimits");
const { createCache } = require("../lib/queryCache");

// A user page's standing/heatmap/volume/mentions are the same for every viewer of that profile
// (privacy flags are checked by the route before these run, not baked into the query) - cached
// for the same reason statsRepo.js's channel-wide numbers are. See lib/queryCache.js.
const { cached: withCache } = createCache({
  ttlMs: limits.STATS_CACHE_TTL_MS,
  maxEntries: limits.STATS_CACHE_MAX_ENTRIES,
});

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    messages: db.collection("messages"),
    userIdentities: db.collection("UserIdentities"),
    userLifetimeStats: db.collection("UserLifetimeStats"),
    userMentionStats: db.collection("UserMentionStats"),
  };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

/**
 * Resolve a URL's <username> to a stable identity.
 *
 * Deliberately searches nickname HISTORY, not just the current name: Twitch users rename, and a
 * link to someone's old handle should still land on their page. UserIdentities.nicknames is
 * exactly this history (the bot appends to it on every message via recordUserIdentity).
 */
async function findUserByName(username) {
  const { userIdentities } = await ensureInitialized();
  const login = String(username || "").toLowerCase().replace(/^@/, "");
  if (!login) return null;

  return (
    (await userIdentities.findOne({ currentUserName: login })) ||
    (await userIdentities.findOne({ "nicknames.name": login }))
  );
}

/**
 * Resolve a list of typed logins to userIds, for the channel dashboard's multi-user log filter.
 *
 * Searches nickname history as well as current names (same reason as findUserByName: a moderator
 * searching for someone probably knows the handle they were using at the time, not the one they
 * renamed to). Unknown logins are simply absent from the result rather than an error - the caller
 * reports which ones didn't resolve.
 */
async function resolveUserIds(logins) {
  const { userIdentities } = await ensureInitialized();

  const wanted = [...new Set((logins || []).map((n) => String(n).toLowerCase().replace(/^@/, "")).filter(Boolean))];
  if (wanted.length === 0) return { users: [], unresolved: [] };

  const docs = await userIdentities
    .find(
      { $or: [{ currentUserName: { $in: wanted } }, { "nicknames.name": { $in: wanted } }] },
      { projection: { userId: 1, currentUserName: 1, nicknames: 1 } }
    )
    .limit(limits.MAX_SEARCH_USERS)
    .toArray();

  const users = docs.map((d) => ({ userId: d.userId, userName: d.currentUserName }));

  // Which of the typed names did we actually account for? A name matches if it is someone's
  // current name OR any of their past ones.
  const matched = new Set();
  for (const doc of docs) {
    if (doc.currentUserName) matched.add(doc.currentUserName.toLowerCase());
    for (const nick of doc.nicknames || []) matched.add(String(nick.name).toLowerCase());
  }

  return { users, unresolved: wanted.filter((n) => !matched.has(n)) };
}

/**
 * Past nicknames, newest first, for the header dropdown.
 *
 * Per spec the UI shows names only, without dates - but we sort by lastSeen here rather than
 * returning them in insertion order, so "most recent alias first" is still true.
 */
function nicknameHistory(identity) {
  if (!identity?.nicknames) return [];
  return identity.nicknames
    .slice()
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
    .map((n) => n.name)
    .filter((name) => name !== identity.currentUserName);
}

/**
 * Message counts bucketed by day - backs the activity heatmap (the volume chart uses
 * getMessageVolume below, which re-buckets per period).
 *
 * Bucketing is done with $dateTrunc in Mongo rather than by reading every message into Node:
 * the server returns at most `days` rows regardless of whether the user sent 10 messages or
 * 100,000.
 */
async function getDailyMessageCounts(channelLogin, userId, days = limits.MAX_HEATMAP_DAYS) {
  const cappedDays = Math.min(days, limits.MAX_HEATMAP_DAYS);
  const key = `heatmap:${withHash(channelLogin)}:${userId}:${cappedDays}`;
  return withCache(key, async () => {
    const { messages } = await ensureInitialized();

    const start = new Date(Date.now() - cappedDays * 86400000);
    start.setHours(0, 0, 0, 0);

    const rows = await messages
      .aggregate(
        [
          { $match: { channel: withHash(channelLogin), userId: String(userId), timestamp: { $gte: start } } },
          { $group: { _id: { $dateTrunc: { date: "$timestamp", unit: "day" } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, date: "$_id", count: 1 } },
        ],
        { allowDiskUse: false }
      )
      .toArray();

    return { days: cappedDays, start, buckets: rows };
  });
}

/**
 * Message counts for the volume chart, with a FIXED number of buckets per period.
 *
 * Day-bucketing alone (getDailyMessageCounts) made the short periods useless as charts: a
 * "day" chart had at most 2 points, "week" 7, while "all" had ~155 - so the line's density
 * said more about the toggle than about the user. Instead each period picks a bucket width
 * that lands every period at the same ~24-31 points, and the series is ZERO-FILLED so a quiet
 * stretch draws as a flat line at 0 rather than being silently skipped (the old behaviour,
 * which also made the x-axis non-linear: consecutive points could be a day or a month apart).
 *
 * Grouping is by integer bucket index relative to `start` - not $dateTrunc - so the bucket
 * boundaries are exactly the ones the zero-fill loop generates, with no timezone/anchor
 * mismatch between Mongo and Node. Windows are rolling (now - N) rather than calendar-aligned:
 * "day" means the last 24 hours.
 */
const VOLUME_BUCKETS = {
  day: { bucketMs: 3600000, count: 24 }, //  1h x 24  = 24h
  week: { bucketMs: 6 * 3600000, count: 28 }, //  6h x 28  = 7d
  month: { bucketMs: 86400000, count: 30 }, //  1d x 30  = 30d
  all: { bucketMs: 5 * 86400000, count: 31 }, //  5d x 31  = 155d = MAX_HEATMAP_DAYS
};

async function getMessageVolume(channelLogin, userId, requestedPeriod) {
  const period = limits.resolvePeriod(requestedPeriod);
  const key = `volume:${withHash(channelLogin)}:${userId}:${period}`;
  return withCache(key, async () => {
    const { messages } = await ensureInitialized();
    const { bucketMs, count } = VOLUME_BUCKETS[period];

    const end = new Date();
    const start = new Date(end.getTime() - bucketMs * count);

    const rows = await messages
      .aggregate(
        [
          { $match: { channel: withHash(channelLogin), userId: String(userId), timestamp: { $gte: start } } },
          {
            $group: {
              _id: { $floor: { $divide: [{ $subtract: ["$timestamp", start] }, bucketMs] } },
              count: { $sum: 1 },
            },
          },
        ],
        { allowDiskUse: false }
      )
      .toArray();

    const byIndex = new Map(rows.map((r) => [Math.min(Math.max(r._id, 0), count - 1), r.count]));
    const buckets = [];
    for (let i = 0; i < count; i++) {
      buckets.push({ date: new Date(start.getTime() + i * bucketMs), count: byIndex.get(i) ?? 0 });
    }

    return { period, bucketMs, start, buckets };
  });
}

/**
 * Total messages + the user's rank among the channel's chatters.
 *
 * Reads the precomputed UserLifetimeStats rather than counting `messages`, and derives rank with
 * a countDocuments of "how many chatters are above me" - which the {channel, messageCount} index
 * answers without touching a single document body. Same approach the bot's getUserRank uses.
 */
async function getLifetimeStanding(channelLogin, userId) {
  const channel = withHash(channelLogin);
  const key = `standing:${channel}:${userId}`;
  return withCache(key, async () => {
    const { userLifetimeStats } = await ensureInitialized();

    const doc = await userLifetimeStats.findOne({ channel, userId: String(userId) });
    const totalMessages = doc?.messageCount ?? 0;
    if (totalMessages === 0) return { totalMessages: 0, rank: null, totalChatters: 0 };

    const [above, totalChatters] = await Promise.all([
      userLifetimeStats.countDocuments({ channel, messageCount: { $gt: totalMessages } }),
      userLifetimeStats.countDocuments({ channel }),
    ]);

    return { totalMessages, rank: above + 1, totalChatters, lastSeen: doc?.lastSeen ?? null };
  });
}

/**
 * How often this user has been @-mentioned.
 *
 * Mentions are recorded against the LOGIN as typed in chat, because that is all the message text
 * carries - so a user who has renamed has their mentions split across their old and new handles.
 * Summing across every known nickname is what makes the number correct, and is precisely why
 * UserIdentities keeps the history.
 *
 * `total` FOLLOWS THE PERIOD: the sum of the ranged days for day/week/month, and the precomputed
 * all-time row (epoch bucket) for `all` - so the headline number always describes the same window
 * the trend next to it draws. `daily` is zero-filled (a day with no mentions is a 0 point, not a
 * missing one), and `all` is re-binned to 5-day bins so its point count (~31) stays in the same
 * range as the other periods instead of ~155. Mentions only exist at day granularity
 * (UserMentionStats is the bot's daily rollup), so `day` is honestly short: 2 points.
 */
async function getMentionStats(channelLogin, identity, requestedPeriod) {
  const channel = withHash(channelLogin);
  const period = limits.resolvePeriod(requestedPeriod);
  const key = `mentions:${channel}:${identity.userId}:${period}`;
  return withCache(key, async () => {
    const { userMentionStats } = await ensureInitialized();

    const logins = [identity.currentUserName, ...(identity.nicknames || []).map((n) => n.name)]
      .filter(Boolean)
      .map((n) => n.toLowerCase());
    const known = [...new Set(logins)];
    if (known.length === 0) return { period, total: 0, daily: [], aliasesCounted: 0 };

    const days = { day: 1, week: 7, month: 30, all: limits.MAX_HEATMAP_DAYS }[period] ?? 7;
    const start = dayBucket(new Date(Date.now() - days * 86400000));

    const [allTime, rows] = await Promise.all([
      userMentionStats
        .aggregate([
          { $match: { channel, mentionedLogin: { $in: known }, date: LIFETIME_BUCKET } },
          { $group: { _id: null, total: { $sum: "$count" } } },
        ])
        .toArray(),
      userMentionStats
        .aggregate(
          [
            // $gte start also excludes the epoch row, so the all-time total never leaks into the trend.
            { $match: { channel, mentionedLogin: { $in: known }, date: { $gte: start } } },
            { $group: { _id: "$date", count: { $sum: "$count" } } },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: "$_id", count: 1 } },
          ],
          { allowDiskUse: false }
        )
        .toArray(),
    ]);

    // Zero-fill: one point per calendar day from `start` through today. Stepping with setDate
    // (not += 86400000) keeps the cursor at the same local noon dayBucket() writes, even across
    // a DST change, so the map keys always line up.
    const byDay = new Map(rows.map((r) => [new Date(r.date).getTime(), r.count]));
    let daily = [];
    const cursor = new Date(start);
    const last = dayBucket(new Date());
    while (cursor.getTime() <= last.getTime()) {
      daily.push({ date: new Date(cursor), count: byDay.get(cursor.getTime()) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    const rangedTotal = daily.reduce((sum, d) => sum + d.count, 0);

    if (period === "all") {
      const BIN_DAYS = 5; // mirrors VOLUME_BUCKETS.all, so both charts land at ~31 points
      const binned = [];
      for (let i = 0; i < daily.length; i += BIN_DAYS) {
        const slice = daily.slice(i, i + BIN_DAYS);
        binned.push({ date: slice[0].date, count: slice.reduce((sum, d) => sum + d.count, 0) });
      }
      daily = binned;
    }

    return {
      period,
      total: period === "all" ? allTime[0]?.total ?? 0 : rangedTotal,
      daily,
      aliasesCounted: known.length,
    };
  });
}

/**
 * Prefix suggestions for the "Find a user" typeahead on /statistics/chat.
 *
 * Channel-scoped FIRST, then name-matched - see statsLimits.js's comment on
 * MAX_USERNAME_SUGGESTION_CANDIDATES for why the reverse order (global name match, narrowed to
 * the channel after) silently drops real matches. The first read is index-only (no document
 * fetch, {channel, messageCount: -1}), so ranking by activity before the $in against
 * UserIdentities costs nothing extra and means the most active matching chatter is always first.
 */
async function searchUsernames(channelLogin, rawQuery) {
  const needle = String(rawQuery || "").toLowerCase().replace(/^@/, "").trim();
  if (needle.length < limits.MIN_USERNAME_QUERY_LENGTH) return [];

  const { userIdentities, userLifetimeStats } = await ensureInitialized();
  const channel = withHash(channelLogin);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefixPattern = new RegExp(`^${escaped}`);

  const topChatters = await userLifetimeStats
    .find({ channel }, { projection: { _id: 0, userId: 1, messageCount: 1 } })
    .sort({ messageCount: -1 })
    .limit(limits.MAX_USERNAME_SUGGESTION_CANDIDATES)
    .toArray();
  if (topChatters.length === 0) return [];

  const countByUserId = new Map(topChatters.map((c) => [c.userId, c.messageCount]));

  const identities = await userIdentities
    .find(
      { userId: { $in: [...countByUserId.keys()] }, currentUserName: prefixPattern },
      { projection: { _id: 0, userId: 1, currentUserName: 1 } }
    )
    .toArray();

  return identities
    .map((d) => ({ userName: d.currentUserName, messageCount: countByUserId.get(d.userId) }))
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, limits.MAX_USERNAME_SUGGESTIONS);
}

module.exports = {
  findUserByName,
  resolveUserIds,
  searchUsernames,
  nicknameHistory,
  getDailyMessageCounts,
  getMessageVolume,
  getLifetimeStanding,
  getMentionStats,
};
