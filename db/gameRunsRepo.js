// One document per started solo-game run (web-only db - the bot never reads
// this). This is the anti-cheat's foundation: a score submission is only
// accepted if it names an open, unexpired run this user started, and consuming
// that run is atomic, so a run can only ever be cashed in once.
//
// Why a stored document rather than a stateless signed token: a self-contained
// HMAC envelope still needs a server-side "already spent" set to be single-use,
// which is a database write anyway - so it buys nothing and costs a second
// mechanism. The same document also carries the seed and startedAt that the
// replay verifier and db/gameRunFlagsRepo.js both need.
//
// {runId, game, userId, sessionId, seed, rulesVersion, startedAt, expiresAt,
//  status: "open"|"used"|"abandoned", usedAt, replayHash, storedScore,
//  checkpointReplay, checkpointAt, checkpointEvents}
//
// CRITICAL: the runId is never rendered into any page. A cheater who scrapes
// data-csrf out of the HTML gets nothing - they have to call run/start.json,
// let real wall-clock time pass, and produce a structurally valid input log.
const crypto = require("crypto");
const { connectWeb } = require("./connection");

let collection;

// How long a run may stay open, per game. Drives the TTL index, and is the
// outer bound the wall-clock plausibility check works within. Fixed-length
// games get their real ceiling plus grace (minesweeper is a 5-minute run
// extendable by 6x10s bonus cells); the open-ended ones get a generous cap,
// and 2048 gets a full day because it can be resumed from localStorage.
const MAX_RUN_MS = {
  minesweeper: 7 * 60 * 1000,
  "match-3": 4 * 60 * 1000,
  "pipe-dodger": 2 * 60 * 60 * 1000,
  "falling-blocks": 4 * 60 * 60 * 1000,
  "cloud-climber": 4 * 60 * 60 * 1000,
  2048: 24 * 60 * 60 * 1000,
};

// A player legitimately has more than one run open at a time - two browser
// tabs, or a reload that left the previous run to expire on its own. Allowing
// exactly one and abandoning the rest would reject the honest run in the first
// tab the moment a second one started. Three is enough for any real usage
// while still bounding how many tokens can be hoarded; the rate limiter and
// the TTL do the rest.
const MAX_OPEN_RUNS = 3;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("GameRuns");
  await collection.createIndex({ runId: 1 }, { unique: true });
  // TTL sweep - a run nobody ever submitted just evaporates.
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  // The open-run count check on start, and the admin "this player's runs" read.
  await collection.createIndex({ userId: 1, game: 1, status: 1, startedAt: -1 });
  return collection;
}

// Mints a run. The seed is what makes the run reproducible AND is what defeats
// replaying somebody else's input log: a different run gets a different seed,
// so the same keystrokes produce a different (and much worse) outcome.
async function startRun({ game, userId, sessionId, rulesVersion }) {
  const col = await ensureInitialized();
  const id = String(userId);
  const now = new Date();
  const maxRunMs = MAX_RUN_MS[game];
  if (!maxRunMs) throw new Error("no MAX_RUN_MS for game: " + game);

  // Retire the oldest still-open runs beyond the allowance rather than all of
  // them, so concurrent tabs keep working (see MAX_OPEN_RUNS).
  const open = await col
    .find({ userId: id, game, status: "open" })
    .project({ runId: 1 })
    .sort({ startedAt: -1 })
    .skip(MAX_OPEN_RUNS - 1)
    .toArray();
  if (open.length) {
    await col.updateMany(
      { runId: { $in: open.map((d) => d.runId) } },
      { $set: { status: "abandoned" } }
    );
  }

  const doc = {
    runId: crypto.randomBytes(16).toString("hex"),
    game,
    userId: id,
    sessionId: sessionId || null,
    seed: crypto.randomInt(0, 4294967296),
    rulesVersion: rulesVersion || 0,
    startedAt: now,
    expiresAt: new Date(now.getTime() + maxRunMs),
    status: "open",
    usedAt: null,
    replayHash: null,
    storedScore: null,
  };
  await col.insertOne(doc);
  return doc;
}

// Atomically flips an open run to "used". Returns the pre-update document, or
// null if there was no matching open unexpired run for this (user, game) -
// which is the single-use guarantee, with no locking and no read-then-write
// race: two concurrent submits, only one can match.
async function consumeRun({ runId, game, userId, replayHash }) {
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    {
      runId: String(runId),
      game,
      userId: String(userId),
      status: "open",
      expiresAt: { $gt: new Date() },
    },
    { $set: { status: "used", usedAt: new Date(), replayHash: replayHash || null } },
    { returnDocument: "before" }
  );
  return result && result.value !== undefined ? result.value : result;
}

// Idempotency: a submit whose response was lost to a network timeout gets
// retried by the client with the same runId, which would otherwise 409 and
// cost an honest player their score. If the run was already consumed by the
// SAME replay, the retry is a duplicate of a request we already honored, not
// a second attempt - the caller answers it with the stored result.
async function findConsumedRun({ runId, game, userId, replayHash }) {
  const col = await ensureInitialized();
  return col.findOne({
    runId: String(runId),
    game,
    userId: String(userId),
    status: "used",
    replayHash: replayHash || null,
  });
}

async function recordStoredScore(runId, storedScore) {
  const col = await ensureInitialized();
  await col.updateOne({ runId: String(runId) }, { $set: { storedScore } });
}

// Mid-run flush for the two open-ended games (falling-blocks, 2048). Does NOT
// consume the run. Exists because a browser caps a keepalive:true fetch body
// at 64kB, which a marathon input log outgrows - the tail submitted at
// game over then only has to cover events since the last checkpoint.
async function saveCheckpoint({ runId, game, userId, replay, eventCount }) {
  const col = await ensureInitialized();
  const result = await col.updateOne(
    { runId: String(runId), game, userId: String(userId), status: "open", expiresAt: { $gt: new Date() } },
    { $set: { checkpointReplay: replay, checkpointAt: new Date(), checkpointEvents: eventCount } }
  );
  return result.matchedCount > 0;
}

async function findOpenRun({ runId, game, userId }) {
  const col = await ensureInitialized();
  return col.findOne({
    runId: String(runId),
    game,
    userId: String(userId),
    status: "open",
    expiresAt: { $gt: new Date() },
  });
}

module.exports = {
  MAX_RUN_MS,
  MAX_OPEN_RUNS,
  startRun,
  consumeRun,
  findConsumedRun,
  findOpenRun,
  recordStoredScore,
  saveCheckpoint,
};
