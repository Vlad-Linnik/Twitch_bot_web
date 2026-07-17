// Aggregate, first-party page-view counter backing the admin panel's Statistics tab. One
// document per calendar day with a running count - never anything that identifies who visited
// (no cookie, no IP, no user id), so it doesn't touch the "no tracking cookies" claim in
// views/privacy.ejs. Lives in the web-only database (connectWeb), same as GameScores/AdminActionLogs.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("SiteVisits");
  await collection.createIndex({ date: 1 }, { unique: true });
  return collection;
}

function dayStart(d = new Date()) {
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day;
}

async function recordVisit() {
  const col = await ensureInitialized();
  await col.updateOne({ date: dayStart() }, { $inc: { count: 1 } }, { upsert: true });
}

// Returns exactly `days` daily counts ending today, oldest first, zero-filled for days with no
// recorded traffic so the admin chart never has to guess about gaps in the series.
async function getDailyVisits(days = 30) {
  const col = await ensureInitialized();
  const start = dayStart();
  start.setDate(start.getDate() - (days - 1));

  const rows = await col.find({ date: { $gte: start } }).sort({ date: 1 }).toArray();
  const byDate = new Map(rows.map((r) => [r.date.getTime(), r.count]));

  const result = [];
  const cursor = new Date(start);
  for (let i = 0; i < days; i++) {
    result.push({ date: new Date(cursor), count: byDate.get(cursor.getTime()) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

module.exports = { recordVisit, getDailyVisits };
