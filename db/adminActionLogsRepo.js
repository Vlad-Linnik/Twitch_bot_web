// Audit trail of tier-0 admin actions taken on /admin (request approve/reject, channel
// enable/disable) - who did what, when, to which target. Web-only DB, same pattern as
// settingsChangeLogRepo. Rendered on /admin/actions.
const { connectWeb } = require("./connection");

const DEFAULT_LIMIT = 25;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("AdminActionLogs");
  await collection.createIndex({ timestamp: -1 });
  return collection;
}

// admin is req.user; action is one of "request.approve" | "request.reject" |
// "channel.enable" | "channel.disable"; target is the affected login;
// details is free-form extra context (e.g. the reject reason).
async function logAction({ admin, action, target, details }) {
  const col = await ensureInitialized();
  await col.insertOne({
    adminId: String(admin.userId),
    adminLogin: admin.login,
    action,
    target: target || null,
    details: details || null,
    timestamp: new Date(),
  });
}

async function listRecent({ page = 1, limit = DEFAULT_LIMIT } = {}) {
  const col = await ensureInitialized();
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * limit;

  const [entries, total] = await Promise.all([
    col.find({}).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments({}),
  ]);

  return { entries, total, totalPages: Math.max(1, Math.ceil(total / limit)), page: safePage };
}

module.exports = { logAction, listRecent };
