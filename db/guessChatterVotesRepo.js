// Player ratings of the lines "Угадай чатера" deals: the question on the card, and each hint
// opened under it.
//
// Two collections, the same split db/higherLowerVotesRepo.js makes and for the same reasons - one
// of them is on the hot path and the other is not:
//
//   GuessChatterVotes   one row per {channel, key, target, userId} - who voted what. Exists so a
//                       person counts once, can change their mind, and can see their own thumb lit
//                       when the same line comes round again.
//   GuessChatterScores  one row per {channel, key} carrying the four running totals. This is what
//                       the draw reads, as a whole small map per channel rather than per line:
//                       only rated lines have a row at all, so it is a handful against a pool of
//                       hundreds of thousands.
//
// `key` is lib/guessChatter.js's questionKey(), NOT the question document's _id. The pool is
// rebuilt weekly and a line that drops out and comes back gets a fresh _id, so the key is the only
// identity a verdict can outlive that on. The same property means rows here outlive the lines they
// judge: a line pruned from the pool keeps its score, and gets it back if it returns.
//
// Both live in the web db, like the pool itself - the bot has no idea this game exists.
const { connectWeb } = require("./connection");
const gc = require("../lib/guessChatter");

let votes;
let scores;

async function ensureInitialized() {
  if (votes && scores) return { votes, scores };
  const db = await connectWeb();
  votes = db.collection("GuessChatterVotes");
  scores = db.collection("GuessChatterScores");
  // Index creation must never be able to fail a page render; the handles above are already cached,
  // so a throw here would 500 the first request after a restart and heal silently on the next.
  try {
    await votes.createIndex({ channel: 1, key: 1, target: 1, userId: 1 }, { unique: true });
    await scores.createIndex({ channel: 1, key: 1 }, { unique: true });
  } catch (err) {
    console.error("[GuessChatterVotes] index creation failed:", err.message);
  }
  return { votes, scores };
}

const field = (target, kind) => (target === "hint" ? `hint_${kind}` : `question_${kind}`);

// Records one person's thumb. Pressing the same thumb again clears it (the natural meaning of
// pressing a pressed button), pressing the other one moves the vote across. The counter update is
// derived from the difference between the old and new vote, so the totals cannot drift away from
// the rows that justify them however often somebody changes their mind.
async function castVote({ channel, key, target, userId, value }) {
  if (!gc.VOTE_TARGETS.includes(target)) throw new Error("bad target: " + target);
  const { votes: v, scores: s } = await ensureInitialized();
  const id = String(userId);

  const existing = await v.findOne({ channel, key, target, userId: id });
  const previous = existing ? existing.value : 0;
  const next = previous === value ? 0 : value;
  if (next === previous) return { value: previous };

  if (next === 0) {
    await v.deleteOne({ channel, key, target, userId: id });
  } else {
    await v.updateOne(
      { channel, key, target, userId: id },
      { $set: { channel, key, target, userId: id, value: next, at: new Date() } },
      { upsert: true }
    );
  }

  const inc = {};
  if (previous === 1) inc[field(target, "likes")] = -1;
  if (previous === -1) inc[field(target, "dislikes")] = -1;
  if (next === 1) inc[field(target, "likes")] = (inc[field(target, "likes")] || 0) + 1;
  if (next === -1) inc[field(target, "dislikes")] = (inc[field(target, "dislikes")] || 0) + 1;

  await s.updateOne({ channel, key }, { $inc: inc, $set: { channel, key } }, { upsert: true });
  return { value: next };
}

// key -> {questionNet, hintNet} for every line anyone has rated in this channel. Small by
// construction, and the caller caches it - see db/guessChatterRepo.js's VOTE_TTL_MS.
async function getScores(channel) {
  const { scores: s } = await ensureInitialized();
  const rows = await s
    .find({ channel })
    .project({ _id: 0, key: 1, question_likes: 1, question_dislikes: 1, hint_likes: 1, hint_dislikes: 1 })
    .toArray();
  const map = new Map();
  for (const r of rows) {
    map.set(r.key, {
      questionNet: (r.question_likes || 0) - (r.question_dislikes || 0),
      hintNet: (r.hint_likes || 0) - (r.hint_dislikes || 0),
    });
  }
  return map;
}

// This player's own thumbs for the lines of one run, so the buttons come back lit. Asked once for
// the whole run rather than per round: the run arrives in a single request, and its questions and
// hints together are a few dozen keys.
async function getUserVotes(channel, userId, keys) {
  if (!userId || !keys || keys.length === 0) return {};
  const { votes: v } = await ensureInitialized();
  const rows = await v
    .find({ channel, userId: String(userId), key: { $in: keys } })
    .project({ _id: 0, key: 1, target: 1, value: 1 })
    .toArray();
  const out = {};
  for (const r of rows) {
    out[r.key] = out[r.key] || {};
    out[r.key][r.target] = r.value;
  }
  return out;
}

module.exports = { castVote, getScores, getUserVotes };
