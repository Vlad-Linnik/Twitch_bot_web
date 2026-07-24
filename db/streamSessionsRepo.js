// Read-only queries against StreamSessions/StreamViewerSamples, owned by the TwitchBot repo
// (TwitchBot/db/chatStats.js's ensureOpenSession/endStreamSession/recordStreamSample, piggybacked
// on ActivitiTracker's existing Get Streams poll). Both collections key by numeric `channelId`
// (matching ModeratorStatistics/ModUpTimeStats), so - unlike messages/UserLifetimeStats - there
// is no "#"-prefix convention to juggle here.
//
// Message-rate itself is NOT stored anywhere new: it's aggregated on the fly from the bot's raw
// `messages` collection, scoped to one session's time range.
const { ObjectId } = require("mongodb");
const { connect } = require("./connection");
const { createCache } = require("../lib/queryCache");
const { buildCategorySegments, messageBucketMs } = require("../lib/streamSessionHelpers");
const { getBoxArtUrls } = require("../twitch/gameBoxArt");
const limits = require("../config/statsLimits");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    sessions: db.collection("StreamSessions"),
    samples: db.collection("StreamViewerSamples"),
    messages: db.collection("messages"),
  };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

// A closed session's data can never change - cache it like any other historical aggregation.
// The open/live session gets its own short-TTL cache instead of no caching at all: it still
// gets queryCache's concurrent-miss dedup (many viewers can open a popular channel's live stats
// page at once), just refreshed often enough to track the bot's own ~5-minute poll cadence.
const { cached: withClosedCache } = createCache({
  ttlMs: limits.STATS_CACHE_TTL_MS,
  maxEntries: limits.STATS_CACHE_MAX_ENTRIES,
});
const { cached: withLiveCache } = createCache({ ttlMs: 20000, maxEntries: 20 });

async function listSessions(channelId, limit = limits.MAX_STREAM_SESSIONS_LISTED) {
  const { sessions } = await ensureInitialized();
  return sessions
    .find({ channelId: String(channelId) }, { projection: { startedAt: 1, endedAt: 1 } })
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
}

async function getSessionById(channelId, sessionId) {
  const { sessions } = await ensureInitialized();

  let _id;
  try {
    _id = new ObjectId(String(sessionId));
  } catch {
    return null; // malformed id = unknown session, same as not found
  }

  // channelId is part of the filter so a valid ObjectId from another channel can't be read
  // through this channel's endpoint.
  return sessions.findOne({ _id, channelId: String(channelId) });
}

async function getViewerSamples(channelId, startedAt, endedAt) {
  const { samples } = await ensureInitialized();
  return samples
    .find(
      { channelId: String(channelId), timestamp: { $gte: startedAt, $lte: endedAt || new Date() } },
      { projection: { _id: 0, timestamp: 1, viewerCount: 1, category: 1 } }
    )
    .sort({ timestamp: 1 })
    .toArray();
}

// Message-rate is computed here, not stored - $group buckets the raw `messages` collection
// server-side so the result set is bounded by MAX_STREAM_CHART_POINTS regardless of how many
// messages the session actually contains (a $group in Mongo, not a Node-side reduce over a
// potentially large fetch). Served by the existing {channel:1, timestamp:-1, userId:1} index's
// channel+time-range prefix - no new index needed on `messages`.
async function getMessageBuckets(channelLogin, startedAt, endedAt) {
  const { messages } = await ensureInitialized();
  const end = endedAt || new Date();
  const bucketMs = messageBucketMs(end - startedAt, limits.MAX_STREAM_CHART_POINTS);

  const rows = await messages
    .aggregate([
      { $match: { channel: withHash(channelLogin), timestamp: { $gte: startedAt, $lte: end } } },
      {
        $group: {
          _id: {
            $subtract: [
              { $toLong: "$timestamp" },
              { $mod: [{ $toLong: "$timestamp" }, bucketMs] },
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return { bucketMs, buckets: rows.map((r) => ({ timestamp: new Date(r._id), count: r.count })) };
}

// The full chart payload for one session: viewer/category samples, the message-rate series, and
// the category segments derived from the samples (see lib/streamSessionHelpers.js). Cached
// per-session - aggressively (STATS_CACHE_TTL_MS) once the session is closed and immutable,
// briefly (20s) while it's still live.
async function getSessionChartData(channel, session) {
  const isLive = !session.endedAt;
  const cache = isLive ? withLiveCache : withClosedCache;
  const key = `streamchart:${session._id}:${session.endedAt ? "closed" : "live"}`;

  return cache(key, async () => {
    const [viewerSamples, messageRate] = await Promise.all([
      getViewerSamples(channel.channelId, session.startedAt, session.endedAt),
      getMessageBuckets(channel.channelLogin, session.startedAt, session.endedAt),
    ]);

    const categorySegments = buildCategorySegments(viewerSamples, session.endedAt || new Date());
    // Enrich each segment with the category's box-art URL (fail-soft: an outage just leaves
    // segments imageless). Done here, not in the pure buildCategorySegments helper, so that
    // helper stays IO-free/unit-testable - and the whole payload is cached per-session, so this
    // Helix round-trip happens about once per stream, not per page view.
    const boxArt = await getBoxArtUrls(categorySegments.map((s) => s.category));
    for (const seg of categorySegments) {
      if (seg.category && boxArt.has(seg.category)) seg.boxArtUrl = boxArt.get(seg.category);
    }

    return {
      session: { id: String(session._id), startedAt: session.startedAt, endedAt: session.endedAt },
      viewerSamples,
      messageBuckets: messageRate.buckets,
      messageBucketMs: messageRate.bucketMs,
      categorySegments,
    };
  });
}

module.exports = { listSessions, getSessionById, getSessionChartData };
