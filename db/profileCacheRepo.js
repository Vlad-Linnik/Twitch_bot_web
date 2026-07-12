// Caches Twitch profile display data (avatar URL, chat color) so pages that
// show a user's identity don't hit Helix on every request. Lives in the
// web-only database (connectWeb) - purely a display-caching concern, the bot
// never reads this. Refreshed if stale, purged if unused - see sweepStaleAndUnused().
const { connectWeb } = require("./connection");
const helixUsers = require("../twitch/helixUsers");
const { getChatColors } = require("../twitch/chatColor");

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("TwitchProfileCache");
  await collection.createIndex({ userId: 1 }, { unique: true });
  return collection;
}

async function fetchFromTwitch(userId) {
  const [[user], colors] = await Promise.all([
    helixUsers.getUsersById([userId]),
    getChatColors([userId]),
  ]);
  return {
    avatarUrl: user?.profile_image_url ?? null,
    chatColor: colors.get(String(userId)) ?? null,
  };
}

// Reads the cache, transparently refreshing if missing/stale, and always bumps
// lastUsedAt - that timestamp IS the "used somewhere on the site" signal the
// 30-day cleanup rule keys off, so every real read must go through this function.
async function getOrFetchProfile(userId) {
  const col = await ensureInitialized();
  const id = String(userId);
  const now = new Date();
  const existing = await col.findOne({ userId: id });

  if (existing && now - existing.lastCheckedAt < STALE_AFTER_MS) {
    await col.updateOne({ userId: id }, { $set: { lastUsedAt: now } });
    return existing;
  }

  try {
    const fresh = await fetchFromTwitch(id);
    const doc = { userId: id, ...fresh, lastCheckedAt: now, lastUsedAt: now };
    await col.updateOne({ userId: id }, { $set: doc }, { upsert: true });
    return doc;
  } catch (err) {
    console.error(`[profileCacheRepo] Twitch fetch failed for user ${id}:`, err.message);
    if (existing) {
      await col.updateOne({ userId: id }, { $set: { lastUsedAt: now } });
      return existing;
    }
    return null;
  }
}

// Refreshes stale entries and deletes long-unused ones - called on a daily
// schedule by twitch/profileCacheScheduler.js, not per-request.
async function sweepStaleAndUnused() {
  const col = await ensureInitialized();
  const now = Date.now();

  const staleDocs = await col.find({ lastCheckedAt: { $lt: new Date(now - STALE_AFTER_MS) } }).toArray();
  for (const doc of staleDocs) {
    try {
      const fresh = await fetchFromTwitch(doc.userId);
      await col.updateOne({ userId: doc.userId }, { $set: { ...fresh, lastCheckedAt: new Date() } });
    } catch (err) {
      console.error(`[profileCacheRepo] refresh failed for user ${doc.userId}:`, err.message);
    }
  }

  const deleted = await col.deleteMany({ lastUsedAt: { $lt: new Date(now - UNUSED_AFTER_MS) } });
  return { refreshed: staleDocs.length, deleted: deleted.deletedCount };
}

module.exports = { getOrFetchProfile, sweepStaleAndUnused };
