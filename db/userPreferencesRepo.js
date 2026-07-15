// Per-user site preferences (language, chat-color override, profile privacy) - purely a web
// concern, lives in the web-only database (connectWeb), never read by the bot.
const { connectWeb } = require("./connection");
const { resolvePrivacy } = require("../lib/privacy");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UserPreferences");
  await collection.createIndex({ userId: 1 }, { unique: true });
  return collection;
}

async function getPreferences(userId) {
  const col = await ensureInitialized();
  return col.findOne({ userId: String(userId) });
}

// `updates` may include any of: locale, chatColorMode ('twitch'|'custom'), customChatColor,
// hideMessageVolume, hideChatActivity, hideProfile.
async function savePreferences(userId, updates) {
  const col = await ensureInitialized();
  await col.updateOne(
    { userId: String(userId) },
    { $set: { ...updates, updatedAt: new Date() }, $setOnInsert: { userId: String(userId) } },
    { upsert: true }
  );
  return getPreferences(userId);
}

// The TARGET user's profile privacy flags (defaults resolved in lib/privacy.js - a user with
// no doc still gets meaningful values). Callers pass the profile owner's id, not the viewer's.
async function getPrivacy(userId) {
  return resolvePrivacy(await getPreferences(userId));
}

module.exports = { getPreferences, savePreferences, getPrivacy };
