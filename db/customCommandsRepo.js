// CRUD for the `custom_commands` collection.
//
// OWNERSHIP: this collection is written by the BOT (TwitchBot/commands/CustomCommands.js, via
// !addcommand/!settimer/!setpin/!delcommand). CLAUDE.md's rule is "never write to a bot-owned
// collection this repo doesn't have an explicit repo module for" - this module is that explicit
// module, and it is now a SHARED-WRITE collection. Two consequences worth knowing:
//
//   1. The document shape is the bot's, not ours: {channel, command, result, timer, pin, announce,
//      announceColor, enabled, categoryTexts}, with `channel` carrying a leading "#" and `timer` in
//      MILLISECONDS (the chat command takes seconds and multiplies). Writing a different shape here
//      would produce commands the bot silently mis-reads. `enabled` and `categoryTexts` (per-stream-
//      category text overrides, see lib/commandValidation.js) are web-panel-only fields - there is
//      no chat command that sets either, same as announceColor.
//   2. The bot caches these in memory. It re-reads them every
//      CustomCommands.REFRESH_INTERVAL_MS (10s) precisely so edits made here reach a running bot
//      without a restart - that refresh was added for this feature. Before it existed, a write
//      here would not have taken effect until the bot was restarted.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("custom_commands");
  // The bot never declared an index here (it reads the whole channel's set into memory at
  // startup), but the panel does per-command lookups, and the uniqueness is a real invariant:
  // the bot's cache is keyed by command name, so two rows with the same {channel, command} would
  // make which one wins non-deterministic.
  await collection.createIndex({ channel: 1, command: 1 }, { unique: true });
  return collection;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

async function list(channelLogin) {
  const col = await ensureInitialized();
  return col
    .find({ channel: withHash(channelLogin) })
    .sort({ command: 1 })
    .toArray();
}

async function findOne(channelLogin, command) {
  const col = await ensureInitialized();
  return col.findOne({ channel: withHash(channelLogin), command });
}

// Upsert rather than insert: matches !addcommand's behaviour, which updates a command's text if it
// already exists instead of erroring.
async function save(channelLogin, { command, result, timer, pin, announce, announceColor, enabled, categoryTexts }) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channel: withHash(channelLogin), command },
    { $set: { channel: withHash(channelLogin), command, result, timer, pin, announce, announceColor, enabled, categoryTexts } },
    { upsert: true }
  );
  return findOne(channelLogin, command);
}

async function remove(channelLogin, command) {
  const col = await ensureInitialized();
  const res = await col.deleteOne({ channel: withHash(channelLogin), command });
  return res.deletedCount > 0;
}

module.exports = { list, findOne, save, remove };
