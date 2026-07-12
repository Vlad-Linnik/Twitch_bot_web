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

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    userLifetimeStats: db.collection("UserLifetimeStats"),
    wordLifetimeStats: db.collection("WordLifetimeStats"),
    modLogs: db.collection("ModeratorActionLogs"),
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

// Top EMOTES, not words: WordLifetimeStats only ever holds whitelisted (7TV/Twitch-global)
// emotes despite its name - see the shared CLAUDE.md's "Words vs emotes". Named accordingly
// here so no caller mistakes it for a word-frequency index (that's ChatWordStats, via
// wordStatsRepo.getChannelWordCloud).
async function getTopEmotes(channelLogin, limit = 10) {
  const { wordLifetimeStats } = await ensureInitialized();
  return wordLifetimeStats
    .find({ channel: withHash(channelLogin) })
    .sort({ count: -1 })
    .limit(limit)
    .toArray();
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

async function getRecentModActions(channelLogin, limit = 25) {
  const { modLogs } = await ensureInitialized();
  return modLogs
    .find({ channel: bareLogin(channelLogin) })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
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

// One row per moderator, rolled up across all of ModeratorStatistics' per-day rows: totals for
// the count-like metrics, day-weighted averages for the rate-like ones (reactionSpeed averages
// only over days that HAD a measured reaction, so quiet days don't drag it toward zero).
// Display name comes from the same UserIdentities $lookup the leaderboard uses; a moderator
// predating that collection still gets a row, keyed by their id.
async function getModeratorSummary(channelId) {
  const { modStats } = await ensureInitialized();
  return modStats
    .aggregate([
      { $match: { channelId: String(channelId) } },
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
  getTopEmotes,
  getChannelTotals,
  getRecentModActions,
  getModUpTime,
  getModStats,
  getModeratorSummary,
  getUserNames,
};
