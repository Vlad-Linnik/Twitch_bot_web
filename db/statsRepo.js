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
  };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;
const bareLogin = (channelLogin) => channelLogin.toLowerCase().replace(/^#/, "");

async function getTopChatters(channelLogin, limit = 10) {
  const { userLifetimeStats } = await ensureInitialized();
  return userLifetimeStats
    .find({ channel: withHash(channelLogin) })
    .sort({ messageCount: -1 })
    .limit(limit)
    .toArray();
}

async function getTopWords(channelLogin, limit = 10) {
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

module.exports = {
  getTopChatters,
  getTopWords,
  getChannelTotals,
  getRecentModActions,
  getModUpTime,
  getModStats,
};
