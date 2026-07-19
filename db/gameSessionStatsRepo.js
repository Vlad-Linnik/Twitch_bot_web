// Total completed-session counters per on-site game, one doc per `game` key:
// {game, playCount}. Deliberately separate from GameScores (db/gameScoresRepo.js):
// GameScores holds one doc per (game, userId), so a counter field there would
// measure player-participations, not matches finished - a 4-player Durak match
// would inflate it 4x. This collection instead gets exactly one $inc per
// finished session/match, from the same call sites that already write to
// GameScores - see routes/games.js's score.json handlers (solo games, one per
// completed run) and realtime/durakRoomManager.js's finalizeGame (multiplayer
// Durak, once per finished room regardless of player count). Same
// "vs-computer Durak is invisible to the server" limitation as GameScores -
// see public/js/games/durak.js.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("GameSessionStats");
  await collection.createIndex({ game: 1 }, { unique: true });
  return collection;
}

async function recordPlay(game) {
  const col = await ensureInitialized();
  await col.updateOne({ game }, { $inc: { playCount: 1 } }, { upsert: true });
}

async function getPlayCounts() {
  const col = await ensureInitialized();
  return col.find({}).sort({ playCount: -1 }).toArray();
}

module.exports = { recordPlay, getPlayCounts };
