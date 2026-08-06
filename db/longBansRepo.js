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
  // Backs listHistoryForChannel's per-channel audit view, sorted newest-first - not covered by
  // any index the bot side already maintains (those are all keyed off status/mode for the
  // poller, see TwitchBot/db/longBansRepo.js).
  await collection.createIndex({ channelId: 1, createdAt: -1 });
  return collection;
}

async function listActiveForChannel(channelId) {
  const col = await ensureInitialized();
  return col
    .find({ channelId: String(channelId), status: { $in: OCCUPYING_STATUSES } })
    .sort({ unbanAt: 1 })
    .toArray();
}

const DEFAULT_HISTORY_LIMIT = 25;

// Every long-ban ever requested for this channel, regardless of status - unlike
// listActiveForChannel (which drops a row the moment it's completed/cancelled/failed), this is
// the audit trail for "who used !longban/the long-bans page and when", including chat-issued
// entries the site has no other record of (SettingsChangeLog only gets web-originated writes -
// see ../CLAUDE.md's "Long-bans: written by both repos, executed only by the bot").
async function listHistoryForChannel(channelId, { page = 1, limit = DEFAULT_HISTORY_LIMIT } = {}) {
  const col = await ensureInitialized();
  const filter = { channelId: String(channelId) };
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * limit;

  const [entries, total] = await Promise.all([
    col.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments(filter),
  ]);

  return { entries, total, totalPages: Math.max(1, Math.ceil(total / limit)), page: safePage };
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
  try {
    await col.insertOne(doc);
  } catch (err) {
    // Mirrors the partial unique index the bot repo maintains on this same collection
    // (TwitchBot/db/longBansRepo.js) - closes the TOCTOU gap between findOccupyingByLogin()'s
    // check above and this insert (e.g. a chat !longban landing in between).
    if (err.code === 11000) {
      const dupErr = new Error(`LongBans: ${doc.userLogin || doc.userId} already has an occupying entry in channel ${doc.channelId}`);
      dupErr.code = "DUPLICATE_OCCUPYING";
      throw dupErr;
    }
    throw err;
  }
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

module.exports = {
  listActiveForChannel,
  listHistoryForChannel,
  findOccupyingByLogin,
  findById,
  create,
  requestCancel,
};
