// Read side of `AutoAnswerHits` - every time an auto-answer topic matched a chat message.
//
// OWNERSHIP: the BOT writes this (TwitchBot/db/autoAnswersRepo.js's recordHit); this app only
// reads it, plus one narrow write - marking a row as a false positive when a moderator presses
// «не то». That single field (`review`) is ours by contract: the bot never reads it.
//
// This feed IS the test mode. A topic in `test` matches and records exactly as a `live` one
// does; the only difference is `sent: false`, so the moderator can watch a new topic work for
// a day without a single message reaching chat. It is also the audit trail for live topics -
// same rows, `sent: true`.
//
// Rows carry `topicTitle` denormalized on purpose: a topic can be deleted while its history
// stays interesting, and a feed that renders "(удалённая тема)" for half its rows is useless
// for judging whether the feature behaves.
const { ObjectId } = require("mongodb");
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AutoAnswerHits");
  await collection.createIndex({ channel: 1, createdAt: -1 });
  await collection.createIndex({ channel: 1, topicId: 1, createdAt: -1 });
  // Self-pruning, same reasoning as DiskUsageSamples: this is a review feed, not a record.
  // Anything a moderator wanted to keep has already been copied into the topic's own
  // antiExamples by the «не то» button, which is a write to AutoAnswers, not to this.
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
  return collection;
}

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

const toObjectId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

/**
 * Most recent hits for a channel, newest first.
 *
 * @param {string} channelLogin
 * @param {{limit?: number, topicId?: string}} [opts]
 */
async function listRecent(channelLogin, opts = {}) {
  const col = await ensureInitialized();
  const query = { channel: withHash(channelLogin) };
  if (opts.topicId) {
    const topicId = toObjectId(opts.topicId);
    if (!topicId) return [];
    query.topicId = topicId;
  }
  return col
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(opts.limit) || 50, 1), 200))
    .toArray();
}

async function findById(channelLogin, id) {
  const _id = toObjectId(id);
  if (!_id) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id, channel: withHash(channelLogin) });
}

/** Counts per topic, for the badge on each topic card. Two numbers only, so one pass. */
async function countsByTopic(channelLogin) {
  const col = await ensureInitialized();
  const rows = await col
    .aggregate([
      { $match: { channel: withHash(channelLogin) } },
      {
        $group: {
          _id: "$topicId",
          total: { $sum: 1 },
          sent: { $sum: { $cond: ["$sent", 1, 0] } },
        },
      },
    ])
    .toArray();
  const out = new Map();
  for (const r of rows) out.set(String(r._id), { total: r.total, sent: r.sent });
  return out;
}

/**
 * Mark a hit as a false positive (or clear the mark).
 *
 * Only ever flips our own `review` field - the row itself is the bot's record of what
 * happened and must not be rewritten after the fact.
 */
async function setReview(channelLogin, id, review) {
  const _id = toObjectId(id);
  if (!_id) return null;
  const col = await ensureInitialized();
  await col.updateOne(
    { _id, channel: withHash(channelLogin) },
    { $set: { review: review || null, reviewedAt: review ? new Date() : null } }
  );
  return findById(channelLogin, id);
}

module.exports = { listRecent, findById, countsByTopic, setReview };
