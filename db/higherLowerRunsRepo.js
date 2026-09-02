// One document per "Выше — ниже" run (web-only db - the bot never reads this).
//
// The run lives on the server because the game's answer IS the data: the challenger's count must
// not reach the browser until the guess is in. That makes this document the game state, not an
// anti-cheat artefact - unlike db/gameRunsRepo.js, there is no replay to verify here, because the
// server itself dealt every round and counted every point.
//
// It also survives a reload on purpose: with a single life, losing a 30-round streak to a dropped
// connection would punish the network rather than the player. The run id is kept in the session,
// so reopening the page resumes the round in progress.
//
// {runId, userId|null, sessionId, channelLogin, mode, period, score, turn,
//  anchor: {word, count}, challenger: {word, count}, recent: [word],
//  startedAt, lastActionAt, expiresAt, status: "open"|"finished", outcome}
const crypto = require("crypto");
const { connectWeb } = require("./connection");

let collection;

// Idle life of a run. Every answer pushes it out again, so this bounds abandonment, not play.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// Two tabs is a normal thing to do and not an exploit worth breaking: a second run shows a second
// pair, and seeing a pair reveals nothing - the count only comes back after an answer, which
// spends the life. The cap is here to bound junk, not to enforce a rule.
const MAX_OPEN_RUNS = 3;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("HigherLowerRuns");
  // Index creation must never be able to fail a page: the handle above is already cached, so a
  // throw here would 500 the first request after every restart and silently work on the next -
  // an error nobody can find in a log. Log and carry on; a missing index is slow, not broken.
  try {
    await collection.createIndex({ runId: 1 }, { unique: true });
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ sessionId: 1, status: 1, startedAt: -1 });
  } catch (err) {
    console.error("[HigherLowerRuns] index creation failed:", err.message);
  }
  return collection;
}

function expiryFrom(now) {
  return new Date(now.getTime() + IDLE_TIMEOUT_MS);
}

async function startRun({ userId, sessionId, channelLogin, mode, period, anchor, challenger }) {
  const col = await ensureInitialized();
  const now = new Date();

  // Retire the oldest open runs past the allowance rather than all of them, so a second tab keeps
  // working - same reasoning as db/gameRunsRepo.js's MAX_OPEN_RUNS.
  const stale = await col
    .find({ sessionId, status: "open" })
    .project({ runId: 1 })
    .sort({ startedAt: -1 })
    .skip(MAX_OPEN_RUNS - 1)
    .toArray();
  if (stale.length) {
    await col.updateMany(
      { runId: { $in: stale.map((d) => d.runId) } },
      { $set: { status: "finished", outcome: "abandoned", finishedAt: now } }
    );
  }

  const doc = {
    runId: crypto.randomBytes(16).toString("hex"),
    userId: userId ? String(userId) : null,
    sessionId,
    channelLogin,
    mode,
    period,
    score: 0,
    turn: 0,
    anchor,
    challenger,
    recent: [anchor.word, challenger.word],
    startedAt: now,
    lastActionAt: now,
    expiresAt: expiryFrom(now),
    status: "open",
    outcome: null,
  };
  await col.insertOne(doc);
  return doc;
}

// The run this session is allowed to act on. Session-scoped rather than user-scoped so a guest
// has one too (guests play, they just never reach the leaderboard).
async function findOpen(runId, sessionId) {
  const col = await ensureInitialized();
  return col.findOne({ runId: String(runId), sessionId, status: "open" });
}

// Advances to the next round. `turn` is the turn being answered, and it is in the FILTER: that is
// what makes a double-click (or a retried request) land once. The loser matches nothing and gets
// a conflict instead of a second point.
async function advance({ runId, sessionId, turn, anchor, challenger, recent }) {
  const col = await ensureInitialized();
  const now = new Date();
  const result = await col.findOneAndUpdate(
    { runId: String(runId), sessionId, status: "open", turn },
    {
      $set: {
        anchor,
        challenger,
        recent,
        lastActionAt: now,
        expiresAt: expiryFrom(now),
      },
      $inc: { score: 1, turn: 1 },
    },
    { returnDocument: "after" }
  );
  return result && result.value !== undefined ? result.value : result;
}

// Closes the run. Same turn-in-the-filter guarantee as advance().
//
// bumpScore counts the answer being given as this call closes the run, which happens only on a
// cleared run - a right answer that leaves no legal opponent behind. A lost run closes on a wrong
// answer, which scores nothing.
async function finish({ runId, sessionId, turn, outcome, bumpScore = false }) {
  const col = await ensureInitialized();
  const now = new Date();
  const update = {
    $set: { status: "finished", outcome, finishedAt: now, lastActionAt: now },
  };
  if (bumpScore) update.$inc = { score: 1 };
  const result = await col.findOneAndUpdate(
    { runId: String(runId), sessionId, status: "open", turn },
    update,
    { returnDocument: "after" }
  );
  return result && result.value !== undefined ? result.value : result;
}

module.exports = {
  startRun,
  findOpen,
  advance,
  finish,
  IDLE_TIMEOUT_MS,
  MAX_OPEN_RUNS,
};
