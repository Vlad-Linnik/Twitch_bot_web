// Reads/writes the bot's existing ModsList collection - schema owned by the
// TwitchBot repo (db/chatStats.js), reused here read-write since assigning
// moderators is a website feature, but the shape/semantics must stay identical
// to what the bot's twitch/moderators.js expects (EventSub-driven live cache).
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("ModsList");
  return collection;
}

async function getModerators(channelId) {
  const col = await ensureInitialized();
  return col.findOne({ channelId: String(channelId) });
}

async function isModerator(channelId, userId) {
  const doc = await getModerators(channelId);
  return !!doc?.moderators?.includes(String(userId));
}

// Reverse lookup for the nav dropdown's "Channels I Can Moderate" - which
// channelIds list this userId as a moderator.
async function getChannelsModeratedBy(userId) {
  const col = await ensureInitialized();
  const docs = await col.find({ moderators: String(userId) }).toArray();
  return docs.map((doc) => doc.channelId);
}

async function addModerator(channelId, userId) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $addToSet: { moderators: String(userId) }, $set: { updatedAt: new Date() } },
    { upsert: true }
  );
}

async function removeModerator(channelId, userId) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $pull: { moderators: String(userId) }, $set: { updatedAt: new Date() } }
  );
}

// Full reconciliation against Twitch's canonical moderator list (Get Moderators, only
// reachable for a channel's own owner - see twitch/channelModerators.js), as opposed to
// addModerator/removeModerator's incremental EventSub-driven updates. Replaces the array
// outright rather than $addToSet/$pull, since the source here is authoritative.
async function setModerators(channelId, moderatorIds) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { moderators: moderatorIds.map(String), updatedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = {
  getModerators,
  isModerator,
  addModerator,
  removeModerator,
  setModerators,
  getChannelsModeratedBy,
};
