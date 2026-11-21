// Web-only (the bot never reads it - see ../CLAUDE.md's shared-collections table): the OBS weather
// widget's settings, one row per channel, written from the owner's setup page.
//
// WeatherWidgets:
//   { channelId, channelLogin,
//     key,                       the secret in the OBS link - the overlay has no session
//     city: { name, admin1?, country?, lat, lon } | absent until the owner picks one
//     style, animations, transitions, units, details, showCity   (lib/weatherWidget.js)
//     createdAt, updatedAt }
//
// The key is stored as it is, like the donation media link keys (db/donationMediaRepo.js): it is
// looked up by value on every poll and shown back to the owner. What it unlocks is the city's
// weather and its name - which is the streamer's whereabouts, hence a key rather than a public
// /:channel URL, and a button that replaces it.
const crypto = require("crypto");
const { connectWeb } = require("./connection");
const { withDefaults } = require("../lib/weatherWidget");

let col;

async function ensureInitialized() {
  if (col) return col;
  const db = await connectWeb();
  const c = db.collection("WeatherWidgets");
  // A failed createIndex must not fail the request that triggered it (../CLAUDE.md).
  try {
    await Promise.all([c.createIndex({ channelId: 1 }, { unique: true }), c.createIndex({ key: 1 }, { unique: true })]);
  } catch (err) {
    console.error("[weatherWidgetRepo] createIndex failed:", err.message);
  }
  col = c;
  return col;
}

function newKey() {
  return crypto.randomBytes(24).toString("base64url");
}

function toConfig(doc) {
  if (!doc) return null;
  return {
    channelId: doc.channelId,
    channelLogin: doc.channelLogin,
    key: doc.key,
    city: doc.city || null,
    settings: withDefaults(doc),
    updatedAt: doc.updatedAt || null,
  };
}

// The row for a channel, created with a fresh key the first time the setup page is opened.
async function getOrCreate(channel) {
  const c = await ensureInitialized();
  const doc = await c.findOneAndUpdate(
    { channelId: String(channel.channelId) },
    {
      $setOnInsert: { channelId: String(channel.channelId), key: newKey(), createdAt: new Date() },
      $set: { channelLogin: channel.channelLogin },
    },
    { upsert: true, returnDocument: "after" }
  );
  return toConfig(doc);
}

async function findByKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
  const c = await ensureInitialized();
  return toConfig(await c.findOne({ key }));
}

// settings: lib/weatherWidget.js's parseSettings(); city: parseCity() or undefined to keep it.
async function save(channelId, { settings, city }) {
  const c = await ensureInitialized();
  const $set = { ...settings, updatedAt: new Date() };
  if (city) $set.city = city;
  await c.updateOne({ channelId: String(channelId) }, { $set });
}

async function regenerateKey(channelId) {
  const c = await ensureInitialized();
  await c.updateOne({ channelId: String(channelId) }, { $set: { key: newKey(), updatedAt: new Date() } });
}

module.exports = { getOrCreate, findByKey, save, regenerateKey };
