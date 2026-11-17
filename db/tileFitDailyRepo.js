// "Укладка" level of the day: one board per date (YYYYMMDD, the same for everyone), ranked by who
// solved it first. Web db (connectWeb) - the bot never reads it. One doc per (day, userId):
// {day, userId, solvedAt}; only the first solve of a day is kept - solving it again does not move
// anyone in the table.
//
// The time is the server's own clock at the moment the checked solution arrived (routes/tileFit.js
// verifies the placement), so unlike a count the browser reports, it cannot be claimed.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  const col = db.collection("TileFitDaily");
  try {
    await col.createIndex({ day: 1, userId: 1 }, { unique: true });
    await col.createIndex({ day: 1, solvedAt: 1 });
    await col.createIndex({ userId: 1, day: -1 });
  } catch (err) {
    console.error("[tileFitDaily] index creation failed:", err.message);
  }
  collection = col;
  return collection;
}

async function record(day, userId) {
  const col = await ensureInitialized();
  try {
    await col.updateOne(
      { day, userId: String(userId) },
      { $setOnInsert: { solvedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err; // a concurrent first solve already wrote it
  }
}

async function top(day, limit) {
  const col = await ensureInitialized();
  return col.find({ day }).sort({ solvedAt: 1 }).limit(limit).project({ _id: 0, userId: 1, solvedAt: 1 }).toArray();
}

async function mine(day, userId) {
  const col = await ensureInitialized();
  const doc = await col.findOne({ day, userId: String(userId) });
  if (!doc) return null;
  const ahead = await col.countDocuments({ day, solvedAt: { $lt: doc.solvedAt } });
  return { solvedAt: doc.solvedAt, rank: ahead + 1 };
}

// Days in a row the user has solved, counting back from `day` (or from the day before it, so a
// streak is not shown as broken in the morning before today's board is done).
async function streak(userId, day, previousDay) {
  const col = await ensureInitialized();
  const days = await col.find({ userId: String(userId) }).sort({ day: -1 }).limit(400).project({ _id: 0, day: 1 }).toArray();
  const have = new Set(days.map((d) => d.day));
  let cursor = have.has(day) ? day : have.has(previousDay(day)) ? previousDay(day) : null;
  let count = 0;
  while (cursor !== null && have.has(cursor)) {
    count++;
    cursor = previousDay(cursor);
  }
  return count;
}

module.exports = { record, top, mine, streak };
