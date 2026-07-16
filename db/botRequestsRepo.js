// "Add the bot to my channel" requests, submitted on /request-bot and resolved on /admin.
// Web-only (the bot never reads these - an APPROVED request materializes as a Channels doc
// via channelsRepo.upsertChannel, and that is what the bot reads), so this lives in the
// web-only DB like SettingsChangeLog/UserPreferences. The approved request doubles as the
// consent record behind Channels.consentedAt - don't delete resolved requests casually.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

const RESOLVED_PAGE_SIZE = 25;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("BotJoinRequests");
  // One PENDING request per user, enforced by the database - a double-submit race gets a
  // duplicate-key error (E11000) instead of a second pending row. Resolved requests are
  // history and may accumulate per user, hence partial rather than plain unique.
  await collection.createIndex(
    { userId: 1 },
    { unique: true, partialFilterExpression: { status: "pending" } }
  );
  await collection.createIndex({ status: 1, createdAt: -1 });
  return collection;
}

// user is req.user ({userId, login, displayName}) - same convention as
// settingsChangeLogRepo.logChange. Throws the raw duplicate-key error on a
// concurrent double-submit; callers treat that as "already pending".
async function create(user, message) {
  const col = await ensureInitialized();
  const doc = {
    userId: String(user.userId),
    login: user.login,
    displayName: user.displayName,
    message: message || "",
    status: "pending",
    createdAt: new Date(),
  };
  await col.insertOne(doc);
  return doc;
}

function isDuplicatePendingError(err) {
  return err && err.code === 11000;
}

async function findPendingByUser(userId) {
  const col = await ensureInitialized();
  return col.findOne({ userId: String(userId), status: "pending" });
}

async function findLatestByUser(userId) {
  const col = await ensureInitialized();
  return col.findOne({ userId: String(userId) }, { sort: { createdAt: -1 } });
}

async function findById(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id: new ObjectId(id) });
}

async function listPending() {
  const col = await ensureInitialized();
  return col.find({ status: "pending" }).sort({ createdAt: 1 }).toArray();
}

async function listResolved({ limit = RESOLVED_PAGE_SIZE } = {}) {
  const col = await ensureInitialized();
  return col
    .find({ status: { $ne: "pending" } })
    .sort({ resolvedAt: -1 })
    .limit(limit)
    .toArray();
}

async function countPending() {
  const col = await ensureInitialized();
  return col.countDocuments({ status: "pending" });
}

// Filters on status:"pending" as well as _id, so a second Approve/Reject click on an
// already-resolved request matches nothing and returns null instead of overwriting the
// first admin's decision.
async function resolve(id, { status, resolvedBy, rejectReason }) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    { _id: new ObjectId(id), status: "pending" },
    {
      $set: {
        status,
        resolvedAt: new Date(),
        resolvedById: String(resolvedBy.userId),
        resolvedByLogin: resolvedBy.login,
        rejectReason: rejectReason || null,
      },
    },
    { returnDocument: "after" }
  );
  return result;
}

module.exports = {
  create,
  isDuplicatePendingError,
  findPendingByUser,
  findLatestByUser,
  findById,
  listPending,
  listResolved,
  countPending,
  resolve,
};
