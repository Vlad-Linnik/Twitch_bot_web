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
//  anchor: {word, count}, challenger: {word, count},
//  queue: [{word, count, card}], recent: [word],
//  startedAt, lastActionAt, expiresAt, status: "open"|"finished", outcome}
//
// `queue` is the rounds dealt ahead of the one on screen (lib/higherLower.js's QUEUE_DEPTH): the
// counts stay here, the `card` beside each is the part the browser is allowed to have early. It
// is what makes answering cheap - one read and one write, no pool, no emote images, no example
// lookup - so the wait between the click and the number is a round trip and nothing else.
const crypto = require("crypto");
const { connectWeb } = require("./connection");
const hl = require("../lib/higherLower");

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

async function startRun({ userId, sessionId, channelLogin, mode, period, anchor, challenger, queue, recent }) {
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
    queue: queue || [],
    // Newest dealt first - see refill(), which uses recent[0] as the chain's head.
    recent: recent || [challenger.word, anchor.word],
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
async function advance({ runId, sessionId, turn, anchor, challenger, queue, recent }) {
  const col = await ensureInitialized();
  const now = new Date();
  const set = {
    anchor,
    challenger,
    queue: queue || [],
    lastActionAt: now,
    expiresAt: expiryFrom(now),
  };
  // Only a draw touches the recent window. Taking the next card off the queue deals nothing new,
  // so leaving it alone here is what keeps this from clobbering a refill that landed in between.
  if (recent) set.recent = recent;
  const result = await col.findOneAndUpdate(
    { runId: String(runId), sessionId, status: "open", turn },
    { $set: set, $inc: { score: 1, turn: 1 } },
    { returnDocument: "after" }
  );
  return result && result.value !== undefined ? result.value : result;
}

// Puts freshly dealt rounds on the back of the queue. Called after the answer has already been
// sent, so nothing about it is on the path the player waits on - which is also why it has to be
// safe against arriving late, or after the run has been lost, or twice.
//
// `head` is the word the first entry was drawn against, and it is in the FILTER. Since every deal
// unshifts into `recent`, recent[0] IS the chain's head, so this is a version check: two refills
// that both drew against the same last card cannot both land, and the loser's cards - drawn
// against a predecessor that is no longer last - are dropped instead of breaking MIN_GAP between
// neighbours. Shifting the queue from the front cannot invalidate it, so an answer racing a
// refill is fine: the entry still follows the card it was drawn against.
async function refill({ runId, sessionId, head, entries }) {
  if (!entries || entries.length === 0) return null;
  const col = await ensureInitialized();
  const words = entries.map((e) => e.word);
  const result = await col.findOneAndUpdate(
    { runId: String(runId), sessionId, status: "open", "recent.0": head },
    {
      $push: {
        queue: { $each: entries },
        // Newest first, bounded - the same window rememberToken() keeps, written atomically
        // because this update races the answer that will consume the queue.
        recent: { $each: [...words].reverse(), $position: 0, $slice: hl.RECENT_MEMORY },
      },
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
  refill,
  finish,
  IDLE_TIMEOUT_MS,
  MAX_OPEN_RUNS,
};
