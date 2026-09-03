// Player ratings of the words "Выше — ниже" deals and of the example lines under them.
//
// Two collections, because they answer two different questions and only one of them is on the hot
// path:
//
//   HigherLowerVotes   one row per {channel, word, target, userId} - who voted what. Exists so a
//                      person counts once, can change their mind, and can see their own thumb
//                      lit when the same word comes round again.
//   HigherLowerScores  one row per {channel, word} carrying the four running totals. This is what
//                      the game reads, and it is read as a whole small map per channel rather
//                      than per word, because only voted-on words have a row at all - a pool of
//                      thousands has a handful of them.
//
// Both live in the web db: the bot has no idea this game exists.
const { connectWeb } = require("./connection");

let votes;
let scores;

const TARGETS = ["word", "example"];

async function ensureInitialized() {
  if (votes && scores) return { votes, scores };
  const db = await connectWeb();
  votes = db.collection("HigherLowerVotes");
  scores = db.collection("HigherLowerScores");
  // Index creation must never be able to fail a page render; the handles above are already
  // cached, so a throw here would 500 the first request after a restart and heal on the next.
  try {
    await votes.createIndex({ channel: 1, word: 1, target: 1, userId: 1 }, { unique: true });
    await scores.createIndex({ channel: 1, word: 1 }, { unique: true });
  } catch (err) {
    console.error("[HigherLowerVotes] index creation failed:", err.message);
  }
  return { votes, scores };
}

const field = (target, kind) => (target === "example" ? `example_${kind}` : `word_${kind}`);

// Records one person's thumb. Pressing the same thumb again clears it (the natural meaning of
// pressing a pressed button), pressing the other one moves the vote across. The counter update
// is derived from the difference between the old and new vote, so the totals cannot drift away
// from the rows that justify them however often somebody changes their mind.
async function castVote({ channel, word, target, userId, value }) {
  if (!TARGETS.includes(target)) throw new Error("bad target: " + target);
  const { votes: v, scores: s } = await ensureInitialized();
  const id = String(userId);

  const existing = await v.findOne({ channel, word, target, userId: id });
  const previous = existing ? existing.value : 0;
  const next = previous === value ? 0 : value;
  if (next === previous) return { value: previous };

  if (next === 0) {
    await v.deleteOne({ channel, word, target, userId: id });
  } else {
    await v.updateOne(
      { channel, word, target, userId: id },
      { $set: { channel, word, target, userId: id, value: next, at: new Date() } },
      { upsert: true }
    );
  }

  const inc = {};
  if (previous === 1) inc[field(target, "likes")] = -1;
  if (previous === -1) inc[field(target, "dislikes")] = -1;
  if (next === 1) inc[field(target, "likes")] = (inc[field(target, "likes")] || 0) + 1;
  if (next === -1) inc[field(target, "dislikes")] = (inc[field(target, "dislikes")] || 0) + 1;

  await s.updateOne({ channel, word }, { $inc: inc, $set: { channel, word } }, { upsert: true });
  return { value: next };
}

// word -> {wordNet, exampleNet} for every word anyone has rated in this channel. Small by
// construction, and the caller caches it - see db/higherLowerRepo.js's VOTE_TTL_MS.
async function getScores(channel) {
  const { scores: s } = await ensureInitialized();
  const rows = await s.find({ channel }).project({ _id: 0, word: 1, word_likes: 1, word_dislikes: 1, example_likes: 1, example_dislikes: 1 }).toArray();
  const map = new Map();
  for (const r of rows) {
    map.set(r.word, {
      wordNet: (r.word_likes || 0) - (r.word_dislikes || 0),
      exampleNet: (r.example_likes || 0) - (r.example_dislikes || 0),
    });
  }
  return map;
}

// This player's own thumbs for the words currently on screen, so the buttons come back lit.
async function getUserVotes(channel, userId, words) {
  if (!userId || !words || words.length === 0) return {};
  const { votes: v } = await ensureInitialized();
  const rows = await v
    .find({ channel, userId: String(userId), word: { $in: words } })
    .project({ _id: 0, word: 1, target: 1, value: 1 })
    .toArray();
  const out = {};
  for (const r of rows) {
    out[r.word] = out[r.word] || {};
    out[r.word][r.target] = r.value;
  }
  return out;
}

module.exports = { castVote, getScores, getUserVotes, TARGETS };
