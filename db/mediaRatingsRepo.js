// Viewer ratings of movie and game cards (MediaRatings, web db): one doc per {itemId, userId},
// {value: 1..10, counted, createdAt, updatedAt}. The source of truth behind the card's cached
// ratings.viewers {sum, count}.
//
// `counted` is decided when the rating is written: only someone who has chatted in this channel
// is in the average (db/chatPresenceRepo.js). Ratings that do not count are still kept - the
// person may chat later, and the next time they rate it is decided again.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("MediaRatings");
  try {
    await collection.createIndex({ itemId: 1, userId: 1 }, { unique: true });
  } catch (err) {
    console.error("[mediaRatingsRepo] createIndex failed:", err.message);
  }
  return collection;
}

const toOid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

async function getUserRating(itemId, userId) {
  const oid = toOid(itemId);
  if (!oid || !userId) return null;
  const col = await ensureInitialized();
  return col.findOne({ itemId: oid, userId: String(userId) });
}

// Writes the rating and returns the previous one (or null), which the caller needs to move the
// card's cache by the exact difference.
async function setRating(itemId, userId, value, counted) {
  const oid = toOid(itemId);
  if (!oid) return null;
  const col = await ensureInitialized();
  const now = new Date();
  return col.findOneAndUpdate(
    { itemId: oid, userId: String(userId) },
    { $set: { value, counted: Boolean(counted), updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: "before" }
  );
}

async function deleteAllFor(itemId) {
  const oid = toOid(itemId);
  if (!oid) return;
  const col = await ensureInitialized();
  await col.deleteMany({ itemId: oid });
}

module.exports = { getUserRating, setRating, deleteAllFor };
