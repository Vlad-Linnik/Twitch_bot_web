// One row per handled mention. This single collection does three jobs on purpose, because all
// three describe the same event:
//   1. the bot's memory of a conversation (the last N exchanges with one viewer in one channel),
//   2. token/cost accounting, which is also what enforces the daily request limit,
//   3. the observe-mode journal of punishments the model proposed but did not carry out.
// Splitting them would mean writing the same call three times.
//
// Written by the bot, read (and reviewed) from the admin panel. Rows expire on a TTL index -
// see setRetentionDays for why the retention knob has to go through collMod.
const { connect } = require("./connection");

const DEFAULT_RETENTION_DAYS = 30;
const TTL_INDEX_NAME = "createdAt_ttl";

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiReplyLog");
  await collection.createIndex({ channel: 1, userId: 1, createdAt: -1 });
  await collection.createIndex({ createdAt: -1 });
  await collection.createIndex({ verdict: 1, createdAt: -1 });
  await collection.createIndex(
    { createdAt: 1 },
    { name: TTL_INDEX_NAME, expireAfterSeconds: DEFAULT_RETENTION_DAYS * 86400 }
  );
  return collection;
}

// A TTL index's expiry cannot be changed by re-issuing createIndex - Mongo treats an index with
// the same key and different options as a conflict - so the retention knob has to be applied with
// collMod. Called from the admin save route, not on every read.
async function setRetentionDays(days) {
  const col = await ensureInitialized();
  const db = await connect();
  await db.command({
    collMod: "AiReplyLog",
    index: { name: TTL_INDEX_NAME, expireAfterSeconds: Math.max(1, Math.round(days)) * 86400 },
  });
  return col;
}

async function listRecent({ limit = 100, channel = null, verdict = null } = {}) {
  const col = await ensureInitialized();
  const query = {};
  if (channel) query.channel = channel;
  if (verdict) query.verdict = verdict;
  return col.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
}

// Counts only rows that actually cost a request - a filter or cache hit writes a row too (it is
// still part of the conversation and of the memory), but it never reached the API.
async function countRequestsSince(since) {
  const col = await ensureInitialized();
  return col.countDocuments({ createdAt: { $gte: since }, billed: true });
}

async function spendSince(since) {
  const col = await ensureInitialized();
  const [row] = await col
    .aggregate([
      { $match: { createdAt: { $gte: since }, billed: true } },
      {
        $group: {
          _id: null,
          requests: { $sum: 1 },
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
          costUsd: { $sum: "$costUsd" },
        },
      },
    ])
    .toArray();
  return row || { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

// The observe-mode review: "would you have done the same?". The answer is the only honest basis
// for deciding whether to switch punishments to enforce, so it is stored per row rather than
// being a thing the admin remembers.
async function setReview(id, review) {
  const { ObjectId } = require("mongodb");
  const col = await ensureInitialized();
  await col.updateOne({ _id: new ObjectId(String(id)) }, { $set: { review, reviewedAt: new Date() } });
}

async function reviewTally() {
  const col = await ensureInitialized();
  const rows = await col
    .aggregate([{ $match: { verdict: "timeout" } }, { $group: { _id: "$review", n: { $sum: 1 } } }])
    .toArray();
  const out = { agree: 0, disagree: 0, unreviewed: 0 };
  for (const r of rows) {
    if (r._id === "agree") out.agree = r.n;
    else if (r._id === "disagree") out.disagree = r.n;
    else out.unreviewed += r.n;
  }
  return out;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  setRetentionDays,
  listRecent,
  countRequestsSince,
  spendSince,
  setReview,
  reviewTally,
};
