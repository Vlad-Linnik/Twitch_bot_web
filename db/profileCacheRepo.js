// Caches Twitch profile display data (avatar URL, chat color, display name,
// login) so pages that show a user's identity don't hit Helix on every request.
// Lives in the web-only database (connectWeb) - purely a display-caching
// concern, the bot never reads this. Refreshed if stale, purged if unused -
// see sweepStaleAndUnused().
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

// A cached doc written before displayName/login were part of the schema must count as a miss
// (one-time refetch wave, bounded by actual page usage) - otherwise pages that need names would
// keep reading name-less docs for up to 7 days.
function isFresh(doc, now) {
  return doc && doc.displayName !== undefined && now - doc.lastCheckedAt < STALE_AFTER_MS;
}

// ONE Helix "Get Users" call + ONE "Get User Chat Color" call for the whole batch (both chunk
// at 100 ids/request internally). An id Helix doesn't return (deleted/banned account) still gets
// a doc with null fields, so it won't be re-fetched on every page view.
async function fetchManyFromTwitch(userIds) {
  const [users, colors] = await Promise.all([
    helixUsers.getUsersById(userIds),
    getChatColors(userIds),
  ]);
  const usersById = new Map(users.map((u) => [String(u.id), u]));
  return new Map(
    userIds.map((id) => {
      const user = usersById.get(String(id));
      return [
        String(id),
        {
          avatarUrl: user?.profile_image_url ?? null,
          chatColor: colors.get(String(id)) ?? null,
          displayName: user?.display_name ?? null,
          login: user?.login ?? null,
        },
      ];
    })
  );
}

async function fetchFromTwitch(userId) {
  const fetched = await fetchManyFromTwitch([String(userId)]);
  return fetched.get(String(userId));
}

// Reads the cache, transparently refreshing if missing/stale, and always bumps
// lastUsedAt - that timestamp IS the "used somewhere on the site" signal the
// 30-day cleanup rule keys off, so every real read must go through this function.
async function getOrFetchProfile(userId) {
  const col = await ensureInitialized();
  const id = String(userId);
  const now = new Date();
  const existing = await col.findOne({ userId: id });

  if (isFresh(existing, now)) {
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

// Batch getOrFetchProfile for pages that render many identities at once (the mod statistics
// page needs ~30: every moderator plus both nick columns of the action log). One $in read, one
// batched Helix fetch for the misses, one bulk upsert. Returns Map<userId(String), doc>; ids
// that could not be resolved at all (Helix down, never cached) are simply absent - callers
// fall back the same way they do for a null getOrFetchProfile.
async function getOrFetchProfiles(userIds) {
  const col = await ensureInitialized();
  // Twitch user ids are numeric strings. A stray non-numeric value (old ModeratorActionLogs
  // rows exist with a LOGIN in modID) can never resolve via Helix's id= lookup - and worse,
  // one malformed id 400s the whole batched request, killing everyone else's names too.
  const ids = [...new Set(userIds.map((id) => String(id)).filter((id) => /^[0-9]+$/.test(id)))];
  const result = new Map();
  if (ids.length === 0) return result;
  const now = new Date();

  const cachedDocs = await col.find({ userId: { $in: ids } }).toArray();
  const cachedById = new Map(cachedDocs.map((doc) => [doc.userId, doc]));

  const freshIds = [];
  const missIds = [];
  for (const id of ids) {
    const doc = cachedById.get(id);
    if (isFresh(doc, now)) {
      freshIds.push(id);
      result.set(id, doc);
    } else {
      missIds.push(id);
    }
  }

  if (freshIds.length > 0) {
    await col.updateMany({ userId: { $in: freshIds } }, { $set: { lastUsedAt: now } });
  }

  if (missIds.length > 0) {
    try {
      const fetched = await fetchManyFromTwitch(missIds);
      const ops = [];
      for (const id of missIds) {
        const doc = { userId: id, ...fetched.get(id), lastCheckedAt: now, lastUsedAt: now };
        ops.push({ updateOne: { filter: { userId: id }, update: { $set: doc }, upsert: true } });
        result.set(id, doc);
      }
      await col.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // Fail-soft, mirroring the single-id path: serve whatever stale docs exist.
      console.error(`[profileCacheRepo] batch Twitch fetch failed (${missIds.length} ids):`, err.message);
      for (const id of missIds) {
        const doc = cachedById.get(id);
        if (doc) result.set(id, doc);
      }
    }
  }

  return result;
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

module.exports = { getOrFetchProfile, getOrFetchProfiles, sweepStaleAndUnused };
