// Per-user best scores for the on-site games (/games/*). Lives in the web-only
// database (connectWeb) - the bot never reads this. One doc per (game, userId):
// {game, userId, bestScore, achievedAt, createdAt}. Only the best score is
// kept, and achievedAt moves ONLY when the best actually improves, so
// leaderboard ties break in favor of whoever reached the score first.
//
// Exception: for "durak-multiplayer", `bestScore` holds a live Elo rating
// (see getRatings/applyEloDelta and realtime/durakElo.js), not a personal
// best - it's expected to go down as well as up, and a missing doc means
// "hasn't finished a rated game yet" rather than "no attempts logged".
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

// Current ratings for a set of players in one game, defaulting anyone with no
// doc yet to `defaultRating` - realtime/durakElo.js needs every participant's
// PRE-game rating to compute this game's deltas. A missing doc is exactly a
// player who hasn't finished a rated game yet, so their rating is still
// "hidden" (see applyEloDelta below) - defaulting it here rather than writing
// a placeholder doc keeps it that way until they actually finish one.
async function getRatings(game, userIds, defaultRating) {
  const col = await ensureInitialized();
  const ids = userIds.map(String);
  const docs = await col.find({ game, userId: { $in: ids } }).toArray();
  const ratings = new Map(ids.map((id) => [id, defaultRating]));
  for (const doc of docs) ratings.set(doc.userId, doc.bestScore);
  return ratings;
}

// Applies one player's Elo rating delta for a game the server itself scored
// (realtime/durakRoomManager.js, via realtime/durakElo.js) - multiplayer
// Durak's `bestScore` field holds a live Elo rating for this game key, not a
// personal best, so unlike submitScore it's expected to go down as well as
// up. A first-time player has no doc at all, so they don't yet appear on the
// leaderboard (`getTop`/`getUserBestAndRank` only ever see existing docs) -
// their rating stays effectively hidden until their first finished game
// creates one, seeded at `baseRating` and immediately adjusted by that game's
// own delta. Race-safe two-step pattern, same reasoning as submitScore: try
// the $inc first (works for every player after their first game), and only
// fall back to inserting a fresh doc if nothing matched; a concurrent insert
// racing us (two of this player's games finishing at once) is resolved by
// retrying as a plain increment.
async function applyEloDelta(game, userId, delta, baseRating) {
  const col = await ensureInitialized();
  const now = new Date();
  const id = String(userId);
  const updated = await col.updateOne({ game, userId: id }, { $inc: { bestScore: delta }, $set: { achievedAt: now } });
  if (updated.matchedCount > 0) return;
  try {
    await col.insertOne({ game, userId: id, bestScore: baseRating + delta, achievedAt: now, createdAt: now });
  } catch (err) {
    // E11000 = a concurrent finish created the doc between our two statements;
    // fall back to incrementing it instead of clobbering their rating.
    if (err.code !== 11000) throw err;
    await col.updateOne({ game, userId: id }, { $inc: { bestScore: delta }, $set: { achievedAt: now } });
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

// Distinct-player counts per game (one doc per (game, userId), so this counts
// how many different players have saved at least one score/rating for that
// game) - backs the admin panel's "most popular games" ranking. It's a
// players-ever proxy, not a total-plays counter: nothing here records repeat
// sessions, and Durak's vs-computer mode never reaches this collection at all
// (see public/js/games/durak.js), so it can never appear in the ranking.
async function getGameCounts() {
  const col = await ensureInitialized();
  return col.aggregate([{ $group: { _id: "$game", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray();
}

module.exports = { submitScore, getRatings, applyEloDelta, getTop, getUserBestAndRank, getGameCounts };
