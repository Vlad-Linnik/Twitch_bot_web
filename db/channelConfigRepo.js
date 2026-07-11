const { connect } = require("./connection");
const defaultConfig = require("../config/defaultChannelConfig.json");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("ChannelConfig");
  await collection.createIndex({ channelLogin: 1 }, { unique: true });
  return collection;
}

// Returns the stored config for a channel, or the default template (not yet
// persisted) if the channel has never saved settings before.
async function getConfig(channelLogin) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const doc = await col.findOne({ channelLogin: login });
  if (doc) return doc;
  return { channelLogin: login, ...defaultConfig, updatedAt: null, updatedBy: null };
}

async function saveConfig(channelLogin, config, updatedBy) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const { bannedWords, spamSignatures, sevenTv, commands, responses } = config;
  await col.updateOne(
    { channelLogin: login },
    {
      $set: {
        bannedWords,
        spamSignatures,
        sevenTv,
        commands,
        responses,
        updatedAt: new Date(),
        updatedBy: String(updatedBy),
      },
      $setOnInsert: { channelLogin: login },
    },
    { upsert: true }
  );
  return getConfig(login);
}

module.exports = { getConfig, saveConfig };
