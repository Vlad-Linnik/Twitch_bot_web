// Answers the model has already given, keyed by the exact question text, so an identical question
// is served for free instead of being paid for again.
//
// PER CHANNEL, unlike the filter. "What are we playing?" has a different right answer in every
// chat, and a shared cache would hand one channel's answer to another with complete confidence.
//
// Only answers the model itself marked as durable are stored (see the `cacheable` field it
// returns) - a question whose answer depends on the moment ("how long has the stream been going")
// is correct exactly once, and a TTL cannot tell the two kinds apart.
const { connect } = require("./connection");
const { aiTextKey } = require("../lib/aiTextKey");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiAnswerCache");
  await collection.createIndex({ channel: 1, text: 1 }, { unique: true });
  await collection.createIndex({ channel: 1, hits: -1 });
  return collection;
}

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

async function listForChannel(channelLogin, { limit = 500 } = {}) {
  const col = await ensureInitialized();
  return col.find({ channel: withHash(channelLogin) }).sort({ hits: -1, _id: -1 }).limit(limit).toArray();
}

async function countForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.countDocuments({ channel: withHash(channelLogin) });
}

async function remove(channelLogin, text) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel: withHash(channelLogin), text: aiTextKey(text) });
}

async function clearChannel(channelLogin) {
  const col = await ensureInitialized();
  const res = await col.deleteMany({ channel: withHash(channelLogin) });
  return res.deletedCount || 0;
}

module.exports = { listForChannel, countForChannel, remove, clearChannel };
