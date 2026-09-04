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
  // Explicit field list, not a spread: it's what keeps a stray body key from ending up in the
  // channel's stored config. The cost is that a NEW top-level config block has to be added here
  // too - `unbanBureau` (the Amnesty Bureau + its sniper) is written by
  // lib/unbanBureauValidation.js's parseUnbanBureau and would silently never persist otherwise,
  // with the settings form appearing to save and every value snapping back to the default.
  const { bannedWords, spamSignatures, spamBanReason, commands, responses, unbanBureau } = config;
  await col.updateOne(
    { channelLogin: login },
    {
      $set: {
        bannedWords,
        spamSignatures,
        spamBanReason: spamBanReason ?? "",
        commands,
        responses,
        unbanBureau,
        updatedAt: new Date(),
        updatedBy: String(updatedBy),
      },
      $setOnInsert: { channelLogin: login },
    },
    { upsert: true }
  );
  return getConfig(login);
}

// The AI mention-reply block is deliberately NOT part of saveConfig above. That function is the
// channel owner's write path; this one is the admin panel's, and the two must not be able to
// overwrite each other. Because saveConfig $sets an explicit field list that never mentions `ai`,
// an owner saving their settings leaves this block untouched, and vice versa - so a stale copy
// read into one form can never clobber what the other form just wrote.
//
// Dotted $set keys rather than a whole-object $set for the same reason at one level down: a new
// per-channel AI field added later must not be wiped by a form that predates it.
async function saveAiConfig(channelLogin, ai, updatedBy) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  await col.updateOne(
    { channelLogin: login },
    {
      $set: {
        "ai.enabled": Boolean(ai.enabled),
        "ai.tone": String(ai.tone ?? ""),
        "ai.cheatsheet": String(ai.cheatsheet ?? ""),
        "ai.banRequesters": Array.isArray(ai.banRequesters) ? ai.banRequesters : [],
        updatedAt: new Date(),
        updatedBy: String(updatedBy),
      },
      $setOnInsert: { channelLogin: login },
    },
    { upsert: true }
  );
  return getConfig(login);
}

module.exports = { getConfig, saveConfig, saveAiConfig };
