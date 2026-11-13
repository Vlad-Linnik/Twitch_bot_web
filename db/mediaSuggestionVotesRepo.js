// "Promote / not now" votes on viewer suggestions (MediaSuggestionVotes, web db): one doc per
// {itemId, userId}, {value: 1|-1, counted, createdAt, updatedAt}. The source of truth behind a
// card's cached votes {score, up, down} (db/mediaItemsRepo.js), which moves by the exact delta of
// each write - lib/mediaSuggestions.js's voteDelta.
//
// `counted` is decided at the vote: only someone who has chatted in this channel moves the score
// (db/chatPresenceRepo.js). Other votes are kept and are re-decided the next time that person votes.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("MediaSuggestionVotes");
  try {
    await collection.createIndex({ itemId: 1, userId: 1 }, { unique: true });
  } catch (err) {
    console.error("[mediaSuggestionVotesRepo] createIndex failed:", err.message);
  }
  return collection;
}

const toOid = (id) => (id instanceof ObjectId ? id : ObjectId.isValid(id) ? new ObjectId(id) : null);

// Map<itemId string, 1|-1> for one viewer across a page of cards, one query.
async function getUserVotes(itemIds, userId) {
  const oids = itemIds.map(toOid).filter(Boolean);
  if (!oids.length || !userId) return new Map();
  const col = await ensureInitialized();
  const docs = await col.find({ itemId: { $in: oids }, userId: String(userId) }).toArray();
  return new Map(docs.map((d) => [String(d.itemId), d.value]));
}

async function getUserVote(itemId, userId) {
  const oid = toOid(itemId);
  if (!oid || !userId) return null;
  const col = await ensureInitialized();
  return col.findOne({ itemId: oid, userId: String(userId) });
}

// Writes the vote (value 0 removes it) and returns the previous doc or null, so the caller can move
// the card's totals by exactly what changed.
async function setVote(itemId, userId, value, counted) {
  const oid = toOid(itemId);
  if (!oid) return null;
  const col = await ensureInitialized();
  const filter = { itemId: oid, userId: String(userId) };
  if (value === 0) return col.findOneAndDelete(filter);
  const now = new Date();
  return col.findOneAndUpdate(
    filter,
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

module.exports = { getUserVotes, getUserVote, setVote, deleteAllFor };
