// Viewers the model decided are not worth answering. They still get the scripted replies; they
// just never reach the API again.
//
// NO TTL, unlike everything else here: the mark is permanent and only an admin can lift it. That
// makes it the most expensive mistake in this feature, which is why it is scoped to the channel
// where it was earned rather than following the person across every chat the bot serves.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiIgnoredUsers");
  await collection.createIndex({ channel: 1, userId: 1 }, { unique: true });
  await collection.createIndex({ createdAt: -1 });
  return collection;
}

async function list({ limit = 500 } = {}) {
  const col = await ensureInitialized();
  return col.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

async function count() {
  const col = await ensureInitialized();
  return col.countDocuments({});
}

async function remove(channel, userId) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel, userId: String(userId) });
}

module.exports = { list, count, remove };
