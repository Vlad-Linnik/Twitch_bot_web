// Read-only queries against collections owned by the TwitchBot repo
// (db/chatStats.js). IMPORTANT convention mismatch inherited from the bot:
//   - messages / UserLifetimeStats / WordLifetimeStats store `channel` WITH
//     a leading "#" (they receive tmi.js's raw channel argument as-is).
//   - ModeratorActionLogs stores `channel` WITHOUT "#" (bare login, from
//     EventSub's broadcaster_user_login).
//   - ModeratorStatistics / ModUpTimeStats key by numeric `channelId`, not
//     a channel string at all.
// Every function below takes a bare `channelLogin` (matching this repo's
// Channels.channelLogin convention) and applies the right prefix internally.
const { connect } = require("./connection");
const { ObjectId } = require("mongodb");
const limits = require("../config/statsLimits");

// A ban/timeout context (the message the user was actioned for + their previous messages) is
// only meaningful when the moderator reacted to something JUST said - past this TTA the last
// logged message is probably unrelated to why they were actioned.
const MOD_ACTION_CONTEXT_MAX_TTA_MS = 45000;
const MOD_ACTION_CONTEXT_MESSAGES = 6; // the flagged message + 5 before it

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    userLifetimeStats: db.collection("UserLifetimeStats"),
    // Per-user daily message counts written by the bot (epoch-sentinel all-time row, daily rows
    // at local noon - same convention as ChatWordStats). Backs the ranged top-chatters periods;
    // `all` keeps reading UserLifetimeStats.
    userDailyMessageStats: db.collection("UserDailyMessageStats"),
    modLogs: db.collection("ModeratorActionLogs"),
    messages: db.collection("messages"),
    modStats: db.collection("ModeratorStatistics"),
    modUpTime: db.collection("ModUpTimeStats"),
    userIdentities: db.collection("UserIdentities"),
  };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;
const bareLogin = (channelLogin) => channelLogin.toLowerCase().replace(/^#/, "");

// Leaderboard rows carrying a display NAME, not just a userId - raw UserLifetimeStats docs
// have no name in them, and rendering numeric IDs to viewers is useless.
//
// $lookup rather than N round-trips: the leaderboard is 10 rows, but the lookup is against
// UserIdentities' unique {userId} index and runs after $limit, so it touches exactly `limit`
// documents. Sorting is served by the {channel, messageCount} index.
async function getLeaderboard(channelLogin, limit = 10) {
  const { userLifetimeStats } = await ensureInitialized();

  const rows = await userLifetimeStats
    .aggregate(
      [
        { $match: { channel: withHash(channelLogin) } },
        { $sort: { messageCount: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: "UserIdentities",
            localField: "userId",
            foreignField: "userId",
            as: "identity",
          },
        },
        {
          $project: {
            _id: 0,
            userId: 1,
            messageCount: 1,
            lastSeen: 1,
            userName: { $arrayElemAt: ["$identity.currentUserName", 0] },
          },
        },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  // A chatter with no UserIdentities row (possible for very old rows predating that collection)
  // still deserves a place on the board - fall back to the id rather than dropping them.
  return rows.map((row, index) => ({
    ...row,
    userName: row.userName || row.userId,
    rank: index + 1,
  }));
}

// Period-switchable top chatters. `all` delegates to getLeaderboard (UserLifetimeStats is the
// all-time source of truth and already carries the $lookup); ranges $group the bot's
// pre-aggregated UserDailyMessageStats - a handful of rows per active user per day, covered by
// its {channel, date, count, userId} index, never a scan over raw `messages`.
async function getTopChatters(channelLogin, period, limit = 10) {
  if (period === "all") return getLeaderboard(channelLogin, limit);

  const { userDailyMessageStats } = await ensureInitialized();
  const start = limits.periodStart(period);

  const rows = await userDailyMessageStats
    .aggregate(
      [
        // $gte start excludes the epoch all-time row automatically (1970 < any real window).
        { $match: { channel: withHash(channelLogin), date: { $gte: start } } },
        { $group: { _id: "$userId", messageCount: { $sum: "$count" } } },
        { $sort: { messageCount: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: "UserIdentities",
            localField: "_id",
            foreignField: "userId",
            as: "identity",
          },
        },
        {
          $project: {
            _id: 0,
            userId: "$_id",
            messageCount: 1,
            userName: { $arrayElemAt: ["$identity.currentUserName", 0] },
          },
        },
      ],
      { allowDiskUse: false }
    )
    .toArray();

  return rows.map((row, index) => ({
    ...row,
    userName: row.userName || row.userId,
    rank: index + 1,
  }));
}

async function getChannelTotals(channelLogin) {
  const { userLifetimeStats } = await ensureInitialized();
  const channel = withHash(channelLogin);
  const [uniqueChatters, totals] = await Promise.all([
    userLifetimeStats.countDocuments({ channel }),
    userLifetimeStats
      .aggregate([{ $match: { channel } }, { $group: { _id: null, messages: { $sum: "$messageCount" } } }])
      .toArray(),
  ]);
  return { uniqueChatters, totalMessages: totals[0]?.messages ?? 0 };
}

// Paginated, newest first. `page` is 1-based. Filters apply to the find AND the count - a
// page count computed from the unfiltered total is exactly the bug this replaced. Included
// moderators ($in on modID) ride the bot's {channel, modID, timestamp} index; the exclude
// ($nin) and action-type filters ride the {channel, timestamp} prefix and post-filter, which
// is fine at this collection's size. Include wins over exclude when both are sent (the UI
// makes them mutually exclusive anyway).
//
// Count-then-find: the page is clamped to the real totalPages BEFORE the find, so a stale
// bookmark (or a filter change that shrank the set) lands on the last page instead of an
// empty one.
async function getRecentModActions(
  channelLogin,
  { page = 1, limit = 25, actions: actionTypes = [], modIds = [], excludeModIds = [] } = {}
) {
  const { modLogs } = await ensureInitialized();
  const filter = { channel: bareLogin(channelLogin) };
  if (actionTypes.length > 0) filter.action = { $in: actionTypes };
  if (modIds.length > 0) filter.modID = { $in: modIds };
  else if (excludeModIds.length > 0) filter.modID = { $nin: excludeModIds };

  const total = await modLogs.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(Math.max(1, page), totalPages);

  const actions = await modLogs
    .find(filter)
    .sort({ timestamp: -1 })
    .skip((clampedPage - 1) * limit)
    .limit(limit)
    .toArray();

  return { actions, total, totalPages, page: clampedPage };
}

// Every moderator id that ever appears in this channel's action log - the filter dropdown's
// option list. Broader than the current ModsList on purpose: ex-mods and bot accounts have
// history worth filtering by. Rides the {channel, modID, timestamp} index.
async function getModActionModIds(channelLogin) {
  const { modLogs } = await ensureInitialized();
  return modLogs.distinct("modID", { channel: bareLogin(channelLogin) });
}

// The chat context behind one mod action: the message the user was actioned for plus the
// MOD_ACTION_CONTEXT_MESSAGES-1 messages THEY posted before it (user decision: the offender's
// own history, not the surrounding channel conversation). Only offered when the moderator
// reacted within MOD_ACTION_CONTEXT_MAX_TTA_MS of the user's last message - a slower action
// (or one against a user who never chatted, TTA null) means the logged messages likely aren't
// what was acted on, so the popup would mislead.
async function getModActionContext(channelLogin, actionId) {
  const { modLogs, messages } = await ensureInitialized();

  let _id;
  try {
    _id = new ObjectId(String(actionId));
  } catch {
    return null; // malformed id = unknown action, same as not found
  }

  // Channel is part of the filter so a valid ObjectId from ANOTHER channel's log can't be
  // read through this channel's (tier-2-gated) endpoint.
  const action = await modLogs.findOne({ _id, channel: bareLogin(channelLogin) });
  if (!action) return null;

  if (action.TTA == null || action.TTA >= MOD_ACTION_CONTEXT_MAX_TTA_MS) {
    return { available: false };
  }

  // Served by the bot's {channel, userId, timestamp} index - at most 6 documents fetched.
  const docs = await messages
    .find({
      channel: withHash(channelLogin),
      userId: action.userId,
      timestamp: { $lte: action.timestamp },
    })
    .sort({ timestamp: -1 })
    .limit(MOD_ACTION_CONTEXT_MESSAGES)
    .toArray();

  docs.reverse(); // chronological for display

  // The flagged message is the one the action's TTA was measured against (messageId, recorded
  // by the bot at action time); older log rows predating that field fall back to "the newest".
  const flaggedId = action.messageId ? String(action.messageId) : null;
  const result = docs.map((doc, i) => ({
    message: doc.message,
    timestamp: doc.timestamp,
    flagged: flaggedId ? String(doc._id) === flaggedId : i === docs.length - 1,
  }));

  return { available: true, messages: result };
}

async function getModUpTime(channelId, limit = 25) {
  const { modUpTime } = await ensureInitialized();
  return modUpTime
    .find({ channelId: String(channelId) })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
}

async function getModStats(channelId, limit = 25) {
  const { modStats } = await ensureInitialized();
  return modStats
    .find({ channelId: String(channelId) })
    .sort({ date: -1 })
    .limit(limit)
    .toArray();
}

// One row per moderator, rolled up across ModeratorStatistics' per-day rows: totals for
// the count-like metrics, day-weighted averages for the rate-like ones (reactionSpeed averages
// only over days that HAD a measured reaction, so quiet days don't drag it toward zero).
// Display name comes from the same UserIdentities $lookup the leaderboard uses; a moderator
// predating that collection still gets a row, keyed by their id.
// `period` narrows the roll-up window ("all" = every row, the previous behavior). No epoch
// sentinel here - the collection is small (days x mods), a full $group is fine.
async function getModeratorSummary(channelId, period = "all") {
  const { modStats } = await ensureInitialized();
  const match = { channelId: String(channelId) };
  const start = limits.periodStart(period);
  if (start !== null) match.date = { $gte: start };
  return modStats
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: "$userId",
          chatActivity: { $sum: "$chatActivity" },
          streamPresence: { $sum: "$streamPresence" },
          reactionSpeed: { $avg: "$reactionSpeed" }, // $avg ignores null days by design
          severity: { $avg: "$severity" },
          moderationActivity: { $sum: "$moderationActivity" },
          days: { $sum: 1 },
          lastDate: { $max: "$date" },
        },
      },
      {
        $lookup: {
          from: "UserIdentities",
          localField: "_id",
          foreignField: "userId",
          as: "identity",
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          chatActivity: 1,
          streamPresence: 1,
          reactionSpeed: 1,
          severity: 1,
          moderationActivity: 1,
          days: 1,
          lastDate: 1,
          userName: { $arrayElemAt: ["$identity.currentUserName", 0] },
        },
      },
      { $sort: { moderationActivity: -1 } },
    ])
    .toArray();
}

// Batch userId -> current display name, for tables that render ids from bot-owned collections
// (mod action logs, ModsList). Returns a Map; callers fall back to the raw id for users with
// no UserIdentities row rather than dropping them.
async function getUserNames(userIds) {
  const ids = [...new Set(userIds.map(String).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { userIdentities } = await ensureInitialized();
  const docs = await userIdentities
    .find({ userId: { $in: ids } }, { projection: { _id: 0, userId: 1, currentUserName: 1 } })
    .toArray();
  return new Map(docs.map((doc) => [doc.userId, doc.currentUserName]));
}

module.exports = {
  getLeaderboard,
  getTopChatters,
  getChannelTotals,
  getRecentModActions,
  getModActionModIds,
  getModActionContext,
  getModUpTime,
  getModStats,
  getModeratorSummary,
  getUserNames,
};
