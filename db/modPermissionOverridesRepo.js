// Per-moderator override of whether a tier-2 moderator may EDIT bot settings/commands/counters
// (viewing is unaffected - this only gates the mutating routes). Web-only collection, entirely
// separate from ModsList (bot-owned, membership-only) and Channels - this repo doesn't touch
// either, so no bot-repo changes are needed for this feature.
//
// Absence of a row = allowed (default-open): a row only needs to exist to record an explicit
// denial, so re-allowing a moderator deletes the row rather than flipping a flag back to true.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("ModPermissionOverrides");
  await collection.createIndex({ channelId: 1, userId: 1 }, { unique: true });
  return collection;
}

async function get(channelId, userId) {
  const col = await ensureInitialized();
  return col.findOne({ channelId: String(channelId), userId: String(userId) });
}

// Map<userId(string), doc> for every override row in the channel - used by the moderators
// management page to render one toggle per ModsList entry without an N+1 query.
async function listForChannel(channelId) {
  const col = await ensureInitialized();
  const docs = await col.find({ channelId: String(channelId) }).toArray();
  return new Map(docs.map((doc) => [doc.userId, doc]));
}

async function deny(channelId, userId, updatedBy) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId), userId: String(userId) },
    { $set: { canEditSettings: false, updatedAt: new Date(), updatedBy: String(updatedBy) } },
    { upsert: true }
  );
}

async function allow(channelId, userId) {
  const col = await ensureInitialized();
  await col.deleteOne({ channelId: String(channelId), userId: String(userId) });
}

module.exports = { get, listForChannel, deny, allow };
