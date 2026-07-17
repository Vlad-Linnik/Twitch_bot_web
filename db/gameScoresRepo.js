// Per-user best scores for the on-site games (/games/*). Lives in the web-only
// database (connectWeb) - the bot never reads this. One doc per (game, userId):
// {game, userId, bestScore, achievedAt, createdAt}. Only the best score is
// kept, and achievedAt moves ONLY when the best actually improves, so
// leaderboard ties break in favor of whoever reached the score first.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("GameScores");
  await collection.createIndex({ game: 1, userId: 1 }, { unique: true });
  // The leaderboard read path: top-N by score for one game.
  await collection.createIndex({ game: 1, bestScore: -1 });
  return collection;
}

async function submitScore(game, userId, score) {
  const col = await ensureInitialized();
  const now = new Date();
  const id = String(userId);
  // Improve-only update: the bestScore filter both keeps worse runs from
  // overwriting a better one and guards the race between two concurrent
  // submits (the losing writer simply matches nothing).
  const improved = await col.updateOne(
    { game, userId: id, bestScore: { $lt: score } },
    { $set: { bestScore: score, achievedAt: now } }
  );
  if (improved.matchedCount > 0) return;
  try {
    await col.updateOne(
      { game, userId: id },
      { $setOnInsert: { bestScore: score, achievedAt: now, createdAt: now } },
      { upsert: true }
    );
  } catch (err) {
    // E11000 = a concurrent submit created the doc between our two statements;
    // their score is already in place, nothing left to do.
    if (err.code !== 11000) throw err;
  }
}

async function getTop(game, limit) {
  const col = await ensureInitialized();
  return col.find({ game }).sort({ bestScore: -1, achievedAt: 1 }).limit(limit).toArray();
}

// Standard competition ranking: 1 + how many players have a strictly higher score.
async function getUserBestAndRank(game, userId) {
  const col = await ensureInitialized();
  const doc = await col.findOne({ game, userId: String(userId) });
  if (!doc) return null;
  const higher = await col.countDocuments({ game, bestScore: { $gt: doc.bestScore } });
  return { bestScore: doc.bestScore, rank: higher + 1 };
}

module.exports = { submitScore, getTop, getUserBestAndRank };
