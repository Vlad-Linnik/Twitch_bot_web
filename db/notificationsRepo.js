// Notifications - the bell in the nav bar. Web db (connectWeb()): the bot never reads these.
//
// Collection `Notifications`, one document per notice, shaped by lib/notifications.js's
// buildReplyNotification:
//   { userId (recipient, string), type: "reply",
//     actorUserId, actorLogin, actorDisplayName,
//     section ("news" | "movies" | "games" | ...), channelLogin (no "#"), itemId, itemTitle,
//     commentId (the reply), parentCommentId, link, excerpt,
//     read, readAt, createdAt }
//
// Self-contained on purpose: the bell draws a row without touching the section's comment
// collection. The flip side is that a removed reply or a deleted item must take its notices with
// it (removeForComment / removeForItem), or the excerpt would outlive the moderation.
//
// Notices expire after NOTIFICATION_TTL_DAYS - an unread reply from half a year ago is not news.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");
const { markReadFilter, markAllReadFilter, DROPDOWN_LIMIT, BADGE_MAX } = require("../lib/notifications");

const COLLECTION = "Notifications";
const NOTIFICATION_TTL_DAYS = 180;

const toOid = (id) => (id instanceof ObjectId ? id : ObjectId.isValid(id) ? new ObjectId(String(id)) : null);

function createNotificationsRepo({ connect = connectWeb } = {}) {
  let collection = null;
  let initializing = null;

  // Index creation is caught and logged: the handle is cached before it runs, and a throw would
  // fail only the first request after a restart (CLAUDE.md, "Conventions that bite").
  async function col() {
    if (collection) return collection;
    if (!initializing) {
      initializing = (async () => {
        const db = await connect();
        const c = db.collection(COLLECTION);
        try {
          await Promise.all([
            c.createIndex({ userId: 1, createdAt: -1 }),
            c.createIndex({ userId: 1, read: 1 }),
            c.createIndex({ commentId: 1 }),
            c.createIndex({ section: 1, itemId: 1 }),
            c.createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_DAYS * 24 * 60 * 60 }),
          ]);
        } catch (err) {
          console.error(`[notificationsRepo] createIndex failed:`, err.message);
        }
        collection = c;
        return c;
      })();
    }
    return initializing;
  }

  async function create(doc) {
    if (!doc) return null;
    const c = await col();
    const result = await c.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  }

  async function listForUser(userId, { limit = DROPDOWN_LIMIT } = {}) {
    const c = await col();
    return c.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  // Counts only as far as the badge can show ("9+"), so a backlog of thousands costs nothing.
  async function countUnread(userId) {
    const c = await col();
    return c.countDocuments(markAllReadFilter(userId), { limit: BADGE_MAX + 1 });
  }

  // The notice itself (for its link) if it belongs to this user, else null. Marks it read.
  async function markRead(userId, notificationId) {
    const oid = toOid(notificationId);
    if (!oid) return null;
    const c = await col();
    const filter = markReadFilter(userId, oid);
    const doc = await c.findOne(filter);
    if (!doc) return null;
    if (!doc.read) await c.updateOne(filter, { $set: { read: true, readAt: new Date() } });
    return { ...doc, read: true };
  }

  async function markAllRead(userId) {
    const c = await col();
    const result = await c.updateMany(markAllReadFilter(userId), { $set: { read: true, readAt: new Date() } });
    return result.modifiedCount || 0;
  }

  async function removeForComment(commentId) {
    const c = await col();
    await c.deleteMany({ commentId: String(commentId) });
  }

  async function removeForItem(section, itemId) {
    const c = await col();
    await c.deleteMany({ section, itemId: String(itemId) });
  }

  return { create, listForUser, countUnread, markRead, markAllRead, removeForComment, removeForItem };
}

module.exports = { ...createNotificationsRepo(), createNotificationsRepo, COLLECTION, NOTIFICATION_TTL_DAYS };
