// Per-channel restriction on who may POST news comments (site-admin/tier-0 only - see
// routes/news.js). Same default-open idiom as db/modPermissionOverridesRepo.js: absence of a row
// means "may comment", a row only exists to record an explicit restriction, so lifting one
// deletes the row rather than flipping a flag. Keyed by channelLogin (not channelId) to match
// every other News* collection in this feature (NewsPosts/NewsComments are both channelLogin-
// keyed) - unlike modPermissionOverridesRepo, nothing here needs the numeric Twitch id.
//
// userLogin is stored alongside userId (like db/longBansRepo.js's target fields) purely for
// display on the admin-only restricted-commenters list - enforcement always checks by userId.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("NewsCommentBans");
  await collection.createIndex({ channelLogin: 1, userId: 1 }, { unique: true });
  return collection;
}

async function isBanned(channelLogin, userId) {
  const col = await ensureInitialized();
  const doc = await col.findOne({ channelLogin: channelLogin.toLowerCase(), userId: String(userId) });
  return Boolean(doc);
}

// The admin-only "restricted commenters" list for one channel.
async function listForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.find({ channelLogin: channelLogin.toLowerCase() }).sort({ createdAt: -1 }).toArray();
}

async function restrict(channelLogin, userId, userLogin, restrictedBy) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelLogin: channelLogin.toLowerCase(), userId: String(userId) },
    { $set: { userLogin, restrictedBy: String(restrictedBy), createdAt: new Date() } },
    { upsert: true }
  );
}

async function unrestrict(channelLogin, userId) {
  const col = await ensureInitialized();
  await col.deleteOne({ channelLogin: channelLogin.toLowerCase(), userId: String(userId) });
}

module.exports = { isBanned, listForChannel, restrict, unrestrict };
