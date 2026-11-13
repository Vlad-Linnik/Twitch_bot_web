// Time on stream per Twitch category for one channel, aggregated from the bot's StreamViewerSamples
// (read-only here; keyed by numeric channelId, see db/streamSessionsRepo.js). Cached for an hour per
// channel: the game grid asks on every page view, the samples grow by one row per five minutes, and
// "23 h" does not need to be fresher than that.
const { connect } = require("./connection");
const { createCache } = require("../lib/queryCache");
const { buildHoursIndex } = require("../lib/streamHours");

const { cached } = createCache({ ttlMs: 60 * 60 * 1000, maxEntries: 200 });

async function hoursIndex(channelId) {
  if (!channelId) return new Map();
  return cached(`streamHours:${channelId}`, async () => {
    const db = await connect();
    const rows = await db
      .collection("StreamViewerSamples")
      .aggregate([
        { $match: { channelId: String(channelId), category: { $type: "string", $ne: "" } } },
        { $group: { _id: "$category", samples: { $sum: 1 }, lastSeen: { $max: "$timestamp" } } },
      ])
      .toArray();
    return buildHoursIndex(rows);
  });
}

module.exports = { hoursIndex };
