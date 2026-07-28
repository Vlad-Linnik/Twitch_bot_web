// CRUD for the `LongBans` collection.
//
// OWNERSHIP: TwitchBot/db/longBansRepo.js is the origin of this document shape. Unlike
// custom_commands/counters, this app can NEVER execute either side of a long-ban itself - it has
// no Twitch moderation-action credentials (see ../CLAUDE.md's "Long-bans: written by both repos,
// executed only by the bot"). So this module only ever writes `status: 'pending'` (a new
// long-ban request - the target's login->id is already resolved via twitch/helixUsers.js before
// writing) or `status: 'cancelRequested'` (asking to lift an already-'active' one).
// TwitchBot/twitch/longBanScheduler.js (polling every ~30s) is the only thing that actually calls
// Twitch's ban/timeout/unban endpoints and promotes those into 'active'/'cancelled'.
const { ObjectId } = require("mongodb");
const { connect } = require("./connection");

// Statuses that mean "this user is currently occupying a long-ban slot" - mirrors the bot's own
// OCCUPYING_STATUSES (TwitchBot/db/longBansRepo.js): a pending/being-cancelled entry must block a
// duplicate submission too, not just a confirmed 'active' one.
const OCCUPYING_STATUSES = ["active", "pending", "cancelRequested"];

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("LongBans");
  return collection;
}

async function listActiveForChannel(channelId) {
  const col = await ensureInitialized();
  return col
    .find({ channelId: String(channelId), status: { $in: OCCUPYING_STATUSES } })
    .sort({ unbanAt: 1 })
    .toArray();
}

async function findOccupyingByLogin(channelId, userLogin) {
  const col = await ensureInitialized();
  return col.findOne({
    channelId: String(channelId),
    userLogin: userLogin.toLowerCase(),
    status: { $in: OCCUPYING_STATUSES },
  });
}

async function findById(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id: new ObjectId(id) });
}

async function create(doc) {
  const col = await ensureInitialized();
  await col.insertOne(doc);
}

// Ends an active or pending long-ban. A still-'pending' one never reached Twitch (nothing to
// unban), so it goes straight to 'cancelled'; an 'active' one needs the bot to actually call
// Twitch's unban endpoint, so it's flagged 'cancelRequested' and
// TwitchBot/twitch/longBanScheduler.js finishes the job within its next ~30s poll.
async function requestCancel(id) {
  const doc = await findById(id);
  if (!doc || !OCCUPYING_STATUSES.includes(doc.status)) return doc;

  const nextStatus = doc.status === "pending" ? "cancelled" : "cancelRequested";
  const col = await ensureInitialized();
  await col.updateOne({ _id: doc._id }, { $set: { status: nextStatus } });
  return { ...doc, status: nextStatus };
}

module.exports = { listActiveForChannel, findOccupyingByLogin, findById, create, requestCancel };
