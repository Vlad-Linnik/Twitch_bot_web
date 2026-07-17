// Audit trail of who changed what on /<channel>/settings, /<channel>/commands and
// /<channel>/counters - a new, web-only collection (this app owns it outright, unlike
// ChannelConfig/custom_commands/counters). Lives in the web-only DB (connectWeb, same
// pattern as db/profileCacheRepo.js) since the bot never needs to read it.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

const DEFAULT_LIMIT = 25;

// Autosave (public/js/autosave.js) saves on every keystroke pause and on every toggle click,
// so one edit "session" (typing a sentence, double-clicking a switch) can fire several POSTs
// a few hundred ms to a few seconds apart. Each is a genuine before/after diff at that instant,
// but logging all of them buries the one meaningful change under a wall of intermediate
// keystroke states. If the same moderator's most recent row for this exact field is still
// within this window, logChange() extends it in place instead of inserting a new one.
const COALESCE_WINDOW_MS = 15000;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("SettingsChangeLog");
  await collection.createIndex({ channelLogin: 1, timestamp: -1 });
  // Cross-channel listing for the admin panel (listRecentAll) - the per-channel index
  // above can't serve a sort with no channelLogin equality prefix.
  await collection.createIndex({ timestamp: -1 });
  return collection;
}

function isEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// user is req.user ({userId, login, displayName}) - already resolved on every authenticated
// request, so a log entry never needs a separate identity lookup at write time.
async function logChange({ channelLogin, user, category, action, target, before, after }) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const normBefore = before === undefined ? null : before;
  const normAfter = after === undefined ? null : after;

  // Only "update" actions come from autosave's rapid-fire saves - list add/delete are
  // discrete button clicks already rate-limited elsewhere, so they're never coalesced.
  if (action === "update") {
    const recent = await col.findOne(
      { channelLogin: login, category, action: "update", target, moderatorId: String(user.userId) },
      { sort: { timestamp: -1 } }
    );
    if (recent && Date.now() - recent.timestamp.getTime() < COALESCE_WINDOW_MS && isEqual(recent.after, normBefore)) {
      // The session round-tripped back to where it started (e.g. a toggle flipped and flipped
      // back) - nothing net changed, so drop the row instead of leaving a confusing same-value
      // entry.
      if (isEqual(recent.before, normAfter)) {
        await col.deleteOne({ _id: recent._id });
      } else {
        await col.updateOne({ _id: recent._id }, { $set: { after: normAfter, timestamp: new Date() } });
      }
      return;
    }
  }

  await col.insertOne({
    channelLogin: login,
    moderatorId: String(user.userId),
    moderatorLogin: user.login,
    moderatorDisplayName: user.displayName,
    timestamp: new Date(),
    category,
    action,
    target,
    before: normBefore,
    after: normAfter,
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

// Cross-channel variant of listRecent for the admin panel's site-wide settings log
// (/admin/settings-log) - same pagination shape, no channel filter.
async function listRecentAll({ page = 1, limit = DEFAULT_LIMIT } = {}) {
  const col = await ensureInitialized();
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * limit;

  const [entries, total] = await Promise.all([
    col.find({}).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
    col.countDocuments({}),
  ]);

  return { entries, total, totalPages: Math.max(1, Math.ceil(total / limit)), page: safePage };
}

// Tier-0 admin-only (routes/admin.js's /admin/settings-log/delete-all) - wipes the audit trail
// site-wide, across every channel. Returns the count so the caller can record it in
// AdminActionLogs, since the rows themselves are gone right after this resolves.
async function deleteAll() {
  const col = await ensureInitialized();
  const result = await col.deleteMany({});
  return result.deletedCount;
}

// Tier-0 admin-only (routes/admin.js's /admin/settings-log/:id/delete) - removes a single entry
// instead of the whole log. Returns the deleted entry (or null if the id didn't match anything,
// e.g. a double-submit) so the caller can log a meaningful target in AdminActionLogs.
async function deleteOne(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  const entry = await col.findOne({ _id: new ObjectId(id) });
  if (!entry) return null;
  await col.deleteOne({ _id: entry._id });
  return entry;
}

module.exports = { logChange, listRecent, listRecentAll, deleteAll, deleteOne };
