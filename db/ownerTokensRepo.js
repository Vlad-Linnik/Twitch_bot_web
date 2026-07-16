// Web-only (never shared with the bot repo - see ../CLAUDE.md's shared-collections table):
// persists a channel owner's Twitch refresh_token so twitch/moderatorSyncScheduler.js can
// keep ModsList reconciled against Get Moderators on a schedule, without requiring the owner
// to be actively logged in. This is a long-lived personal credential, not a session artifact,
// so it's encrypted at rest (lib/tokenCrypto.js) and lives in the web-only database like
// UserPreferences/TwitchProfileCache.
const { connectWeb } = require("./connection");
const { encrypt, decrypt } = require("../lib/tokenCrypto");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("OwnerModTokens");
  await collection.createIndex({ channelId: 1 }, { unique: true });
  return collection;
}

async function saveRefreshToken(channelId, ownerId, refreshToken) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    {
      $set: { ownerId: String(ownerId), refreshTokenEnc: encrypt(refreshToken), updatedAt: new Date() },
    },
    { upsert: true }
  );
}

// Used by the scheduler sweep - decrypts every stored token in one pass.
async function listAll() {
  const col = await ensureInitialized();
  const docs = await col.find({}).toArray();
  return docs.map((doc) => ({
    channelId: doc.channelId,
    ownerId: doc.ownerId,
    refreshToken: decrypt(doc.refreshTokenEnc),
  }));
}

// Admin health tile: which channels have a stored owner token at all (an enabled channel
// without one gets no scheduled moderator sync). IDs only - never decrypts anything.
async function listChannelIds() {
  const col = await ensureInitialized();
  const docs = await col.find({}, { projection: { channelId: 1 } }).toArray();
  return docs.map((doc) => doc.channelId);
}

// Called when Twitch rejects a stored refresh token (revoked consent, etc.) - stop
// tracking this owner until they log in again, which re-saves a fresh one.
async function remove(channelId) {
  const col = await ensureInitialized();
  await col.deleteOne({ channelId: String(channelId) });
}

module.exports = { saveRefreshToken, listAll, listChannelIds, remove };
