const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("Channels");
  await collection.createIndex({ channelLogin: 1 }, { unique: true });
  await collection.createIndex({ channelId: 1 }, { unique: true });
  return collection;
}

async function findByLogin(channelLogin) {
  const col = await ensureInitialized();
  return col.findOne({ channelLogin: channelLogin.toLowerCase() });
}

async function listEnabled() {
  const col = await ensureInitialized();
  return col.find({ enabled: true }).sort({ channelLogin: 1 }).toArray();
}

// Unlike listEnabled(), not filtered by `enabled` - used by the public /commands reference
// page, where a channel's command docs (including its real custom_commands rows) should stay
// visible regardless of whether the bot is currently joining that channel.
async function listAll() {
  const col = await ensureInitialized();
  return col.find({}).sort({ channelLogin: 1 }).toArray();
}

// A Twitch user can own at most one channel - ownerId doubles as that
// channel's channelId (see upsertChannel/seedChannel.js), so this is a
// single-doc lookup, not a list. Used by the nav dropdown's "Creator Dashboard".
async function findByOwnerId(ownerId) {
  const col = await ensureInitialized();
  return col.findOne({ ownerId: String(ownerId), enabled: true });
}

// Used by the nav dropdown's "Channels I Can Moderate" (modsRepo.getChannelsModeratedBy
// returns channelIds, this resolves them to full Channel docs).
async function findManyByIds(channelIds) {
  const col = await ensureInitialized();
  if (!channelIds.length) return [];
  return col.find({ channelId: { $in: channelIds.map(String) }, enabled: true }).sort({ channelLogin: 1 }).toArray();
}

async function upsertChannel({ channelLogin, channelId, ownerId }) {
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const now = new Date();
  await col.updateOne(
    { channelLogin: login },
    {
      $set: { channelId: String(channelId), ownerId: String(ownerId), enabled: true, updatedAt: now },
      // consentedAt is the consent trail behind the /privacy page's "channels are added only
      // at the owner's request" claim: seedChannel.js is only ever run on such a request.
      // $setOnInsert so re-seeding an existing channel can't rewrite the original date.
      $setOnInsert: { channelLogin: login, createdAt: now, consentedAt: now },
    },
    { upsert: true }
  );
  return findByLogin(login);
}

module.exports = { findByLogin, listEnabled, listAll, upsertChannel, findByOwnerId, findManyByIds };
