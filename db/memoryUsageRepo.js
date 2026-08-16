// Reads the hourly MemoryUsageSamples TwitchBot's twitch/memoryUsageScheduler.js writes into the
// shared twitch_chat_stats db (see ../CLAUDE.md's shared-collections table). Backs the admin
// panel's Memory tab (routes/admin.js, lib/memoryUsageAnalysis.js does the number-crunching).
const { connect } = require("./connection");

async function getSamples(days) {
  const db = await connect();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return db.collection("MemoryUsageSamples")
    .find({ timestamp: { $gte: since } })
    .sort({ timestamp: 1 })
    .toArray();
}

module.exports = { getSamples };
