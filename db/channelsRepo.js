const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("Channels");
  await collection.createIndex({ channelLogin: 1 }, { unique: true });
  await collection.createIndex({ channelId: 1 }, { unique: true });
  return collection;
}

async function findByLogin(channelLogin) {
  const col = await ensureInitialized();
  return col.findOne({ channelLogin: channelLogin.toLowerCase() });
}

async function listEnabled() {
  const col = await ensureInitialized();
  return col.find({ enabled: true }).sort({ channelLogin: 1 }).toArray();
}

async function upsertChannel({ channelLogin, channelId, ownerId }) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const now = new Date();
  await col.updateOne(
    { channelLogin: login },
    {
      $set: { channelId: String(channelId), ownerId: String(ownerId), enabled: true, updatedAt: now },
      $setOnInsert: { channelLogin: login, createdAt: now },
    },
    { upsert: true }
  );
  return findByLogin(login);
}

module.exports = { findByLogin, listEnabled, upsertChannel };
