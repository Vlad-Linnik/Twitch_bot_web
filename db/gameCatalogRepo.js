// Web-only (connectWeb) admin controls over the /games hub: per-game
// visibility and grouping games into categories. Neither collection is read
// by the bot - purely a site-presentation concern for data/gamesCatalog.js's
// static catalog.
//
// GameSettings: one doc per catalog game id - {_id: gameId, hidden, categoryId,
// antiCheat}. A game with no doc is visible and uncategorized (the catalog
// default).
//
// `antiCheat` is the solo games' anti-cheat kill switch, per game, flippable
// from /admin/games without a deploy (see lib/gameReplay/index.js):
//   "off"      - accept whatever the client sends, as before this feature
//   "observe"  - replay and flag, but STORE THE CLIENT'S score (default)
//   "enforce"  - store the server's re-simulated score
// A game stays on "observe" until its client/server score-agreement rate has
// actually been measured on live traffic; promoting on a hunch is how an
// engine divergence turns into honest players silently losing points.
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

const ANTI_CHEAT_MODES = ["off", "observe", "enforce"];
const DEFAULT_ANTI_CHEAT_MODE = "observe";

// Read on every score submission, so it's cached briefly - a settings flip
// reaching live behavior within a few seconds is plenty, and the alternative
// is a database round-trip inside the submit path of every finished game.
let modeCache = null;
let modeCacheAt = 0;
const MODE_CACHE_MS = 5000;

async function getAntiCheatMode(gameId) {
  const now = Date.now();
  if (!modeCache || now - modeCacheAt > MODE_CACHE_MS) {
    await ensureInitialized();
    const docs = await settingsCol.find({}, { projection: { antiCheat: 1 } }).toArray();
    modeCache = new Map(docs.map((d) => [d._id, d.antiCheat]));
    modeCacheAt = now;
  }
  const mode = modeCache.get(gameId);
  return ANTI_CHEAT_MODES.includes(mode) ? mode : DEFAULT_ANTI_CHEAT_MODE;
}

async function setAntiCheatMode(gameId, mode) {
  if (!ANTI_CHEAT_MODES.includes(mode)) throw new Error("unknown antiCheat mode: " + mode);
  await ensureInitialized();
  await settingsCol.updateOne({ _id: gameId }, { $set: { antiCheat: mode } }, { upsert: true });
  modeCache = null;
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
  ANTI_CHEAT_MODES,
  DEFAULT_ANTI_CHEAT_MODE,
  getAntiCheatMode,
  setAntiCheatMode,
  getSettingsMap,
  setHidden,
  setCategory,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
};
