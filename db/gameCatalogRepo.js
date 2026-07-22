// Web-only (connectWeb) admin controls over the /games hub: per-game
// visibility and grouping games into categories. Neither collection is read
// by the bot - purely a site-presentation concern for data/gamesCatalog.js's
// static catalog.
//
// GameSettings: one doc per catalog game id - {_id: gameId, hidden, categoryId}.
// A game with no doc is visible and uncategorized (the catalog default).
//
// GameCategories: {_id, names, createdAt} - display order is creation order,
// oldest first (no manual reordering yet). `names` is a per-locale map
// ({en, ru} - config/i18n.js's SUPPORTED_LOCALES) so a category created by
// one admin reads correctly for a visitor on the other locale, same reason
// every other visitor-facing string on the site goes through config/locales/
// rather than being stored as a single hardcoded string.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let settingsCol;
let categoriesCol;

async function ensureInitialized() {
  if (settingsCol && categoriesCol) return;
  const db = await connectWeb();
  settingsCol = db.collection("GameSettings");
  categoriesCol = db.collection("GameCategories");
  await categoriesCol.createIndex({ createdAt: 1 });
}

// Map<gameId, {hidden, categoryId}> for every game with a settings doc -
// callers treat a missing entry as {hidden: false, categoryId: null}.
async function getSettingsMap() {
  await ensureInitialized();
  const docs = await settingsCol.find({}).toArray();
  return new Map(docs.map((d) => [d._id, d]));
}

async function setHidden(gameId, hidden) {
  await ensureInitialized();
  await settingsCol.updateOne({ _id: gameId }, { $set: { hidden: Boolean(hidden) } }, { upsert: true });
}

// categoryId null/undefined clears the assignment (game falls back to the
// uncategorized bucket on /games).
async function setCategory(gameId, categoryId) {
  await ensureInitialized();
  const value = categoryId && ObjectId.isValid(categoryId) ? new ObjectId(categoryId) : null;
  await settingsCol.updateOne({ _id: gameId }, { $set: { categoryId: value } }, { upsert: true });
}

async function listCategories() {
  await ensureInitialized();
  return categoriesCol.find({}).sort({ createdAt: 1 }).toArray();
}

// names: {en, ru} - both required, enforced by the admin route before this is called.
async function createCategory(names) {
  await ensureInitialized();
  const doc = { names, createdAt: new Date() };
  const result = await categoriesCol.insertOne(doc);
  return { _id: result.insertedId, ...doc };
}

async function renameCategory(id, names) {
  await ensureInitialized();
  if (!ObjectId.isValid(id)) return;
  await categoriesCol.updateOne({ _id: new ObjectId(id) }, { $set: { names } });
}

// Deleting a category unassigns (not deletes) every game that pointed at it,
// so those games just fall back into the uncategorized bucket on /games.
async function deleteCategory(id) {
  await ensureInitialized();
  if (!ObjectId.isValid(id)) return;
  const oid = new ObjectId(id);
  await categoriesCol.deleteOne({ _id: oid });
  await settingsCol.updateMany({ categoryId: oid }, { $set: { categoryId: null } });
}

module.exports = {
  getSettingsMap,
  setHidden,
  setCategory,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
};
