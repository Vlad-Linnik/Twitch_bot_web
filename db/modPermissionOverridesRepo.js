// Per-moderator denials of the right to CHANGE a section of the channel's management (viewing is
// unaffected - only the mutating routes ask). The sections, the rule and the reading of older rows
// are lib/moderatorSections.js; this module only stores. Web-only collection, entirely separate
// from ModsList (bot-owned, membership-only) and Channels - the bot never reads it.
//
// Shape: {channelId, userId, deny: [sectionKey, ...], updatedAt, updatedBy}. Absence of a row =
// everything allowed (default-open): a row only exists to record a denial, so allowing every
// section deletes it. Older rows carry `canEditSettings: false` instead of `deny`; setDenied drops
// that field the first time the moderator is saved.
const { connectWeb } = require("./connection");

let collection;
let indexReady = false;

async function ensureInitialized() {
  if (!collection) {
    const db = await connectWeb();
    collection = db.collection("ModPermissionOverrides");
  }
  if (!indexReady) {
    indexReady = true;
    try {
      await collection.createIndex({ channelId: 1, userId: 1 }, { unique: true });
    } catch (err) {
      indexReady = false;
      console.error("[modPermissionOverridesRepo] createIndex failed:", err);
    }
  }
  return collection;
}

async function get(channelId, userId) {
  const col = await ensureInitialized();
  return col.findOne({ channelId: String(channelId), userId: String(userId) });
}

// Map<userId(string), doc> for every override row in the channel - used by the moderators
// management page to render one row per ModsList entry without an N+1 query.
async function listForChannel(channelId) {
  const col = await ensureInitialized();
  const docs = await col.find({ channelId: String(channelId) }).toArray();
  return new Map(docs.map((doc) => [doc.userId, doc]));
}

// `deny`: section keys, already validated by the caller (lib/moderatorSections.js). An empty list
// removes the row.
async function setDenied(channelId, userId, deny, updatedBy) {
  const col = await ensureInitialized();
  const filter = { channelId: String(channelId), userId: String(userId) };
  if (!deny.length) {
    await col.deleteOne(filter);
    return;
  }
  await col.updateOne(
    filter,
    {
      $set: { deny: [...deny], updatedAt: new Date(), updatedBy: String(updatedBy) },
      $unset: { canEditSettings: "" },
    },
    { upsert: true }
  );
}

module.exports = { get, listForChannel, setDenied };
