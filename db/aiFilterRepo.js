// "This message is not worth an API call" - message text mapped to a canned reply, checked before
// the model is ever contacted. Rows are added both by the model itself (when it decides a message
// did not deserve the call it just cost) and by hand from the admin panel.
//
// GLOBAL, not per channel: "hi", "ku" and a lone emote mean the same thing everywhere, and making
// each channel relearn them would mean paying for that lesson once per channel. The answer cache
// (aiCacheRepo) is the opposite case and is deliberately per channel.
//
// hits/lastHitAt exist so the list stays prunable. Without them a table that only ever grows is
// impossible to review a month later - there is no way to tell a live entry from a dead one.
const { connect } = require("./connection");
const { aiTextKey } = require("../lib/aiTextKey");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiFilter");
  await collection.createIndex({ text: 1 }, { unique: true });
  await collection.createIndex({ hits: -1 });
  return collection;
}

async function list({ limit = 500 } = {}) {
  const col = await ensureInitialized();
  return col.find({}).sort({ hits: -1, _id: -1 }).limit(limit).toArray();
}

async function count() {
  const col = await ensureInitialized();
  return col.countDocuments({});
}

// source: "ai" (the model added it after answering) or "admin" (added by hand).
async function upsert({ text, answer, source }) {
  const col = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return null;
  await col.updateOne(
    { text: key },
    {
      $set: { answer: String(answer ?? "") },
      $setOnInsert: { text: key, source: source || "admin", hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
  return key;
}

async function remove(text) {
  const col = await ensureInitialized();
  await col.deleteOne({ text: aiTextKey(text) });
}

module.exports = { list, count, upsert, remove };
