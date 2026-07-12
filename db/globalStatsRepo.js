// Site-wide stats for the home page, reading collections the bot repo owns
// (TwitchBot/db/chatStats.js) in the shared twitch_chat_stats db.
const { connect } = require("./connection");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    commandStats: db.collection("CommandExecutionStats"),
    wordLifetimeStats: db.collection("WordLifetimeStats"),
    whiteList: db.collection("whiteList"),
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

// Read live rather than the bot's GlobalEmoteStats running-total doc, which only counted pairs
// inserted AFTER the counter was introduced (undercounts, never catches up, can drift). Both
// source collections are small - a few hundred rows per channel, not the ~1.9M-row `messages`
// collection - so live reads here are cheap.
//
// totalEntriesAdded = whiteList size (config: every emote the bot is set up to track - 7TV set +
// Twitch global - whether or not it's been typed in chat yet), NOT WordLifetimeStats.countDocuments()
// (usage: only emotes actually seen at least once). "Tracked" means configured, not observed -
// same {channel, word} pair in two channels correctly counts as two separate entries.
// totalUsageCount is genuinely a usage measure, so it stays on WordLifetimeStats (sum of `count`).
async function getGlobalEmoteStats() {
  const { wordLifetimeStats, whiteList } = await ensureInitialized();
  const [totalEntriesAdded, usageResult] = await Promise.all([
    whiteList.countDocuments(),
    wordLifetimeStats.aggregate([{ $group: { _id: null, total: { $sum: "$count" } } }]).toArray(),
  ]);
  return { totalUsageCount: usageResult[0]?.total ?? 0, totalEntriesAdded };
}

// UserIdentities already has one doc per distinct Twitch userId across every
// channel, so this is already deduplicated - no new bot-side tracking needed.
async function getGlobalUniqueUserCount() {
  const { userIdentities } = await ensureInitialized();
  return userIdentities.countDocuments();
}

module.exports = { getGlobalCommandCount, getGlobalEmoteStats, getGlobalUniqueUserCount };
