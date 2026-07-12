// Site-wide stats for the home page, reading collections the bot repo owns
// (TwitchBot/db/chatStats.js) in the shared twitch_chat_stats db.
const { connect } = require("./connection");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    commandStats: db.collection("CommandExecutionStats"),
    globalEmoteStats: db.collection("GlobalEmoteStats"),
    userIdentities: db.collection("UserIdentities"),
  };
  return collections;
}

// One row per channel (small collection) - cheap to sum on every page load,
// unlike emote usage, so no running-total cache is needed here.
async function getGlobalCommandCount() {
  const { commandStats } = await ensureInitialized();
  const result = await commandStats.aggregate([{ $group: { _id: null, total: { $sum: "$count" } } }]).toArray();
  return result[0]?.total ?? 0;
}

// Reads the bot's running-total doc (TwitchBot/db/chatStats.js maintains this
// incrementally) instead of summing WordLifetimeStats, which would get
// expensive as the number of tracked {channel, word} pairs grows.
async function getGlobalEmoteStats() {
  const { globalEmoteStats } = await ensureInitialized();
  const doc = await globalEmoteStats.findOne({ _id: "global" });
  return { totalUsageCount: doc?.totalUsageCount ?? 0, totalEntriesAdded: doc?.totalEntriesAdded ?? 0 };
}

// UserIdentities already has one doc per distinct Twitch userId across every
// channel, so this is already deduplicated - no new bot-side tracking needed.
async function getGlobalUniqueUserCount() {
  const { userIdentities } = await ensureInitialized();
  return userIdentities.countDocuments();
}

module.exports = { getGlobalCommandCount, getGlobalEmoteStats, getGlobalUniqueUserCount };
