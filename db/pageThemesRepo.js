// Per-user page themes - the "throne" skin that replaces the default look of
// /<channel>/user/<name>. Web-only concern, so it lives in the web database (connectWeb); the
// bot has no idea this collection exists.
//
// Keyed by userId and NOT by channel: a theme describes a person, not a channel, so the same
// hall renders on that user's page in every channel the bot serves. One doc per user, shaped by
// lib/pageThemeValidation.js's parseSubmittedTheme.
//
// Kept out of UserPreferences on purpose, even though both are "settings for a user in the web
// db": UserPreferences is written by the user themselves (locale, chat colour, privacy flags),
// while a theme is written by a site admin on that user's behalf. Two different writers with
// two different permission gates in one document is how a save from one side silently reverts
// the other.
const { connectWeb } = require("./connection");
const { resolveTheme } = require("../lib/pageThemeValidation");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UserPageThemes");
  await collection.createIndex({ userId: 1 }, { unique: true });
  // The admin list reads enabled themes first, then most recently touched - the collection is
  // tiny, but this is also the index that keeps "is anyone using this?" a single scan.
  await collection.createIndex({ enabled: -1, updatedAt: -1 });
  return collection;
}

// The raw document, or null when the user has never had a theme. Callers that need to RENDER
// should use getResolvedTheme instead; this one exists for the editor, which must be able to
// tell "no document yet" from "a document with everything at its default".
async function getTheme(userId) {
  const col = await ensureInitialized();
  return col.findOne({ userId: String(userId) });
}

// Render-side read: always returns a complete theme object, `enabled: false` for users with no
// document, so a page never has to null-check its way through a skin.
async function getResolvedTheme(userId) {
  return resolveTheme(await getTheme(userId));
}

// Every theme, enabled ones first - the admin index at /admin/page-themes. Display names are
// not stored here; the route joins them through userProfileService so a renamed user is never
// listed under a stale nickname.
async function listThemes() {
  const col = await ensureInitialized();
  return col.find({}).sort({ enabled: -1, updatedAt: -1 }).toArray();
}

// `theme` is the full parsed shape from parseSubmittedTheme - a whole-document write, because
// the editor form renders every field it owns. Asset URLs and storageBytes are inside that
// shape (carried over by the parser), so a text-only save can't drop an upload.
async function saveTheme(userId, theme, updatedBy) {
  const col = await ensureInitialized();
  await col.updateOne(
    { userId: String(userId) },
    {
      $set: { ...theme, updatedAt: new Date(), updatedBy: updatedBy == null ? null : String(updatedBy) },
      $setOnInsert: { userId: String(userId), createdAt: new Date() },
    },
    { upsert: true }
  );
  return getTheme(userId);
}

// Deleting the document is how a theme is removed for good; disabling it is a field on the
// form. Files on disk are the caller's problem - it must unlink them BEFORE calling this, or
// the URLs that pointed at them are gone and the bytes leak.
async function deleteTheme(userId) {
  const col = await ensureInitialized();
  await col.deleteOne({ userId: String(userId) });
}

module.exports = { getTheme, getResolvedTheme, listThemes, saveTheme, deleteTheme };
