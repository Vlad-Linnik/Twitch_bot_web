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

// Read live from WordLifetimeStats rather than the bot's GlobalEmoteStats running-total doc:
// that doc's totalEntriesAdded only counts pairs inserted AFTER the counter was introduced, so
// it undercounts (reads as 0 for a channel whose emote set was already fully populated before
// this feature shipped) and never catches up. WordLifetimeStats itself is small - "tracked
// emotes" is a few hundred rows per channel, not the ~1.9M-row `messages` collection - so a live
// countDocuments()/$group here is cheap, and unlike a running counter it can't drift.
async function getGlobalEmoteStats() {
  const { wordLifetimeStats } = await ensureInitialized();
  const [totalEntriesAdded, usageResult] = await Promise.all([
    wordLifetimeStats.countDocuments(),
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
