const { connect } = require("./connection");
const defaultConfig = require("../config/defaultChannelConfig.json");
const { deepMerge } = require("../lib/deepMerge");

// Commands that used to exist in the defaults but have been removed from the bot.
// Old ChannelConfig docs still carry them; without this filter they'd resurface in
// the settings UI's trailing "other" group. saveConfig $sets the whole `commands`
// object, so the stale key self-purges from Mongo on the channel's next save.
const REMOVED_COMMANDS = ["addword"];

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("ChannelConfig");
  await collection.createIndex({ channelLogin: 1 }, { unique: true });
  return collection;
}

// Returns the stored config for a channel deep-merged over the default template
// (same semantics as the bot's config/channelSettings.js), so commands added to
// the defaults after a channel's doc was written still show up on its settings
// pages. Falls back to the bare template (not yet persisted) for a channel that
// has never saved settings before.
async function getConfig(channelLogin) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const doc = await col.findOne({ channelLogin: login });
  const base = { channelLogin: login, ...defaultConfig, updatedAt: null, updatedBy: null };
  const merged = doc ? deepMerge(base, doc) : base;
  // Copy before deleting - with no doc, `commands` is still a reference into the
  // required defaultConfig module and must not be mutated.
  merged.commands = { ...merged.commands };
  for (const name of REMOVED_COMMANDS) delete merged.commands[name];
  return merged;
}

async function saveConfig(channelLogin, config, updatedBy) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const { bannedWords, spamSignatures, spamBanReason, commands, responses } = config;
  await col.updateOne(
    { channelLogin: login },
    {
      $set: {
        bannedWords,
        spamSignatures,
        spamBanReason: spamBanReason ?? "",
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
