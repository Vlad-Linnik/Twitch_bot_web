// "Укладка" progress: which levels each account has solved. Web db (connectWeb) - the bot never
// reads it. One doc per user: {userId, solved: [levelNumbers], updatedAt}.
//
// The leaderboard figure is the COUNT of solved levels and lives in GameScores under "tile-fit"
// like every other game's, so the shared leaderboard code reads it unchanged. This collection is
// what makes that count honest: a level is added only after routes/tileFit.js has rebuilt it and
// checked the submitted placement covers it, and $addToSet means solving one level twice still
// counts once.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  const col = db.collection("TileFitProgress");
  try {
    await col.createIndex({ userId: 1 }, { unique: true });
  } catch (err) {
    console.error("[tileFitProgress] index creation failed:", err.message);
  }
  collection = col;
  return collection;
}

async function getSolved(userId) {
  const col = await ensureInitialized();
  const doc = await col.findOne({ userId: String(userId) }, { projection: { solved: 1 } });
  return doc && Array.isArray(doc.solved) ? doc.solved.slice().sort((a, b) => a - b) : [];
}

// Returns the number of distinct levels solved after this one is recorded.
async function markSolved(userId, level) {
  const col = await ensureInitialized();
  const doc = await col.findOneAndUpdate(
    { userId: String(userId) },
    { $addToSet: { solved: level }, $set: { updatedAt: new Date() } },
    { upsert: true, returnDocument: "after", projection: { solved: 1 } }
  );
  const value = doc && doc.value !== undefined && doc.solved === undefined ? doc.value : doc;
  return value && Array.isArray(value.solved) ? value.solved.length : 1;
}

// Several levels at once (a guest's progress, verified, arriving after they log in). Returns the
// number of distinct levels solved afterwards.
async function markSolvedMany(userId, levels) {
  const col = await ensureInitialized();
  const doc = await col.findOneAndUpdate(
    { userId: String(userId) },
    { $addToSet: { solved: { $each: levels } }, $set: { updatedAt: new Date() } },
    { upsert: true, returnDocument: "after", projection: { solved: 1 } }
  );
  const value = doc && doc.value !== undefined && doc.solved === undefined ? doc.value : doc;
  return value && Array.isArray(value.solved) ? value.solved.length : 0;
}

module.exports = { getSolved, markSolved, markSolvedMany };
