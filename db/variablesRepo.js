// CRUD for the `variables` collection.
//
// OWNERSHIP: this collection is written by the BOT (TwitchBot/commands/CustomCommands.js's
// Variables class, via !addvar/!delvar/#name updates). Like custom_commands, it is a
// SHARED-WRITE collection and this module is the explicit repo CLAUDE.md requires. Two
// consequences worth knowing:
//
//   1. The document shape is the bot's, not ours: {channel, name, value, access}, with
//      `channel` carrying a leading "#", names lowercase [a-zа-яё0-9]+ (the bot's matcher
//      never lowercases the message, so an uppercase name could never be updated from chat),
//      `value` an integer, and `access` either "all" or "mods". TwitchBot/db/chatStats.js's
//      variable methods are the other half of this contract.
//   2. The bot caches variables in memory. It re-reads them on
//      CustomCommands.refreshFromDatabase()'s 10s tick (which calls
//      Variables.refreshFromDatabase()) precisely so edits made here reach a running bot
//      without a restart.
//
// Chat increments go through an atomic $inc; save() here $sets `value` outright (an
// explicit admin edit), so a chat increment landing in the same instant is last-write-wins.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("variables");
  // Uniqueness is a real invariant: the bot's cache is keyed by name, so two rows with the same
  // {channel, name} would make which one wins non-deterministic. The bot creates the same index;
  // whichever side starts first wins and the other's call is a no-op. Logged rather than thrown,
  // so a failed createIndex cannot leave a cached handle behind a failed first page render.
  await collection
    .createIndex({ channel: 1, name: 1 }, { unique: true })
    .catch((err) => console.error("[variablesRepo] index error:", err.message));
  return collection;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

async function list(channelLogin) {
  const col = await ensureInitialized();
  return col
    .find({ channel: withHash(channelLogin) })
    .sort({ name: 1 })
    .toArray();
}

async function findOne(channelLogin, name) {
  const col = await ensureInitialized();
  return col.findOne({ channel: withHash(channelLogin), name });
}

// Upsert rather than insert: mirrors customCommandsRepo.save - the page's edit button
// copies a row back into the same form, so "create" and "edit" are the same request.
async function save(channelLogin, { name, value, access }) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channel: withHash(channelLogin), name },
    { $set: { channel: withHash(channelLogin), name, value, access } },
    { upsert: true }
  );
  return findOne(channelLogin, name);
}

async function remove(channelLogin, name) {
  const col = await ensureInitialized();
  const res = await col.deleteOne({ channel: withHash(channelLogin), name });
  return res.deletedCount > 0;
}

module.exports = { list, findOne, save, remove };
