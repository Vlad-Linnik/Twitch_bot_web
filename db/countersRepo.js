// CRUD for the `counters` collection.
//
// OWNERSHIP: this collection is written by the BOT (TwitchBot/commands/CustomCommands.js's
// Counter class, via !addcounter/!delcounter/#name updates). Like custom_commands, it is a
// SHARED-WRITE collection and this module is the explicit repo CLAUDE.md requires. Two
// consequences worth knowing:
//
//   1. The document shape is the bot's, not ours: {channel, counter_name, count, access},
//      with `channel` carrying a leading "#", names lowercase [a-zа-я0-9]+ (the bot's
//      matcher never lowercases the message, so an uppercase name could never be updated
//      from chat), and `access` either "all" or "mods".
//   2. The bot caches counters in memory. It re-reads them on
//      CustomCommands.refreshFromDatabase()'s 10s tick (which calls
//      Counter.refreshFromDatabase()) precisely so edits made here reach a running bot
//      without a restart - that refresh was added for this feature.
//
// Chat increments go through an atomic $inc; save() here $sets `count` outright (an
// explicit admin edit), so a chat increment landing in the same instant is last-write-wins.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("counters");
  // The bot never declared an index here (it reads the whole channel's set into memory at
  // startup), but uniqueness is a real invariant: the bot's cache is keyed by counter name,
  // so two rows with the same {channel, counter_name} would make which one wins
  // non-deterministic.
  await collection.createIndex({ channel: 1, counter_name: 1 }, { unique: true });
  return collection;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

async function list(channelLogin) {
  const col = await ensureInitialized();
  return col
    .find({ channel: withHash(channelLogin) })
    .sort({ counter_name: 1 })
    .toArray();
}

async function findOne(channelLogin, counterName) {
  const col = await ensureInitialized();
  return col.findOne({ channel: withHash(channelLogin), counter_name: counterName });
}

// Upsert rather than insert: mirrors customCommandsRepo.save - the page's edit button
// copies a row back into the same form, so "create" and "edit" are the same request.
async function save(channelLogin, { counter_name, count, access }) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channel: withHash(channelLogin), counter_name },
    { $set: { channel: withHash(channelLogin), counter_name, count, access } },
    { upsert: true }
  );
  return findOne(channelLogin, counter_name);
}

async function remove(channelLogin, counterName) {
  const col = await ensureInitialized();
  const res = await col.deleteOne({ channel: withHash(channelLogin), counter_name: counterName });
  return res.deletedCount > 0;
}

module.exports = { list, findOne, save, remove };
