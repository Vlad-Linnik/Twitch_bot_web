// Audit trail of who changed what on /<channel>/settings, /<channel>/commands and
// /<channel>/counters - a new, web-only collection (this app owns it outright, unlike
// ChannelConfig/custom_commands/counters). Lives in the web-only DB (connectWeb, same
// pattern as db/profileCacheRepo.js) since the bot never needs to read it.
const { connectWeb } = require("./connection");

const DEFAULT_LIMIT = 25;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("SettingsChangeLog");
  await collection.createIndex({ channelLogin: 1, timestamp: -1 });
  return collection;
}

// user is req.user ({userId, login, displayName}) - already resolved on every authenticated
// request, so a log entry never needs a separate identity lookup at write time.
async function logChange({ channelLogin, user, category, action, target, before, after }) {
  const col = await ensureInitialized();
  await col.insertOne({
    channelLogin: channelLogin.toLowerCase(),
    moderatorId: String(user.userId),
    moderatorLogin: user.login,
    moderatorDisplayName: user.displayName,
    timestamp: new Date(),
    category,
    action,
    target,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });
}

async function listRecent(channelLogin, { page = 1, limit = DEFAULT_LIMIT } = {}) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * limit;

  const [entries, total] = await Promise.all([
    col.find({ channelLogin: login }).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments({ channelLogin: login }),
  ]);

  return { entries, total, totalPages: Math.max(1, Math.ceil(total / limit)), page: safePage };
}

module.exports = { logChange, listRecent };
