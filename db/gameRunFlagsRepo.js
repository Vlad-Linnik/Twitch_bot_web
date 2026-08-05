// Suspicious solo-game runs, queued for a human to look at on /admin/game-runs.
// Web-only db.
//
// This is DELIBERATELY a separate collection rather than a field on GameScores:
// that collection is shared with the multiplayer Elo path (gameScoresRepo's
// applyEloDelta) and must not grow anti-cheat state.
//
// Nothing here ever blocks a player. Timing heuristics in particular have a
// real false-positive rate (a player holding an arrow key, a browser that
// coarsens performance.now() for privacy), so they FLAG and a human decides.
// The hard rejections - a missing/expired/spent run token, a structurally
// impossible replay - never reach this collection; they're refused outright at
// the route.
const { connectWeb } = require("./connection");

let collection;

const SEVERITIES = ["low", "medium", "high"];
// Raw replays are kept only for flags worth investigating, and only up to this
// size - at ~100 flags/day this bounds the collection's growth on a 2GB VPS.
const MAX_STORED_REPLAY_BYTES = 64 * 1024;
// A dismissed flag self-cleans after this long; an OPEN one has no expiresAt
// at all and lives until somebody reviews it (the TTL index only acts on
// documents that actually have the field).
const DISMISSED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("GameRunFlags");
  await collection.createIndex({ runId: 1 }, { unique: true });
  // The admin queue's default read: open flags, worst first.
  await collection.createIndex({ "review.status": 1, severity: -1, createdAt: -1 });
  await collection.createIndex({ createdAt: -1 });
  await collection.createIndex({ userId: 1, createdAt: -1 });
  await collection.createIndex({ game: 1, createdAt: -1 });
  // Only dismissed documents carry expiresAt, so this expires exactly those.
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return collection;
}

// reasons: [{code, detail}] - e.g. {code: "scoreMismatch", detail: {claimed, computed}}
async function recordFlag(input) {
  const col = await ensureInitialized();
  const severity = SEVERITIES.includes(input.severity) ? input.severity : "low";
  const keepReplay =
    severity !== "low" &&
    typeof input.replay === "string" &&
    input.replay.length <= MAX_STORED_REPLAY_BYTES;

  const doc = {
    runId: input.runId,
    game: input.game,
    userId: String(input.userId),
    createdAt: new Date(),
    startedAt: input.startedAt || null,
    submittedAt: input.submittedAt || new Date(),
    serverElapsedMs: input.serverElapsedMs ?? null,
    simElapsedMs: input.simElapsedMs ?? null,
    claimedScore: input.claimedScore ?? null,
    storedScore: input.storedScore ?? null,
    // Triage shortcut: a flagged run that didn't even beat the player's own
    // previous best is almost never worth an admin's attention.
    previousBest: input.previousBest ?? null,
    verified: Boolean(input.verified),
    rulesVersion: input.rulesVersion ?? null,
    reasons: Array.isArray(input.reasons) ? input.reasons : [],
    severity,
    replayHash: input.replayHash || null,
    replayBytes: input.replayBytes ?? null,
    replay: keepReplay ? input.replay : null,
    review: { status: "open", by: null, at: null, note: null },
  };

  try {
    await col.insertOne(doc);
  } catch (err) {
    // A retried submit can race a flag we already wrote for that run; the
    // first one stands.
    if (err.code !== 11000) throw err;
  }
  return doc;
}

async function listFlags({ status, game, severity, skip = 0, limit = 25 } = {}) {
  const col = await ensureInitialized();
  const query = {};
  if (status) query["review.status"] = status;
  if (game) query.game = game;
  if (severity) query.severity = severity;
  const [docs, total] = await Promise.all([
    col.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(query),
  ]);
  return { docs, total };
}

async function countOpen() {
  const col = await ensureInitialized();
  return col.countDocuments({ "review.status": "open" });
}

async function findById(id) {
  const col = await ensureInitialized();
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(id)) return null;
  return col.findOne({ _id: new ObjectId(id) });
}

// status: "dismissed" (nothing wrong, let it expire) or "actioned" (the admin
// took a corrective step, e.g. reset the score).
async function reviewFlag(id, { status, by, note }) {
  const col = await ensureInitialized();
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(id)) return false;
  const set = {
    "review.status": status,
    "review.by": by ? String(by) : null,
    "review.at": new Date(),
    "review.note": note || null,
  };
  // Only a resolved flag gets an expiry - open ones must never quietly vanish.
  if (status === "dismissed" || status === "actioned") {
    set.expiresAt = new Date(Date.now() + DISMISSED_RETENTION_MS);
  }
  const result = await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
  return result.matchedCount > 0;
}

module.exports = {
  SEVERITIES,
  MAX_STORED_REPLAY_BYTES,
  recordFlag,
  listFlags,
  countOpen,
  findById,
  reviewFlag,
};
