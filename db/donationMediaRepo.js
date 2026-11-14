// Web-only (the bot never reads these - see ../CLAUDE.md's shared-collections table): the
// donation media feature's two collections.
//
// DonationMediaSettings - one row per channel, written from the setup page:
//   { channelId, channelLogin,
//     playerKey, panelKey,                       the secrets in the OBS links (see below)
//     donationAlerts: { tokenEnc, currency },
//     donatello:      { userIdEnc, widgetIdEnc },
//     donatePay:      { tokenEnc, origin },
//     placeholderUrl,                            the owner's own placeholder picture, or absent
//                                                (lib/donationMediaPlaceholder.js)
//     createdAt, updatedAt }
// The platform credentials are encrypted at rest (lib/tokenCrypto.js), like the owner refresh
// tokens: each of them reads the streamer's donations, donor names included. The two link keys are
// stored as they are, because they are looked up by value on every OBS connection and shown back
// to the owner on the setup page; what they unlock is this channel's player and queue panel, and
// the setup page replaces them with one button.
//
// DonationMediaQueues - one row per channel, the queue itself (lib/donationMediaQueue.js's
// toStored()), so a deploy does not throw away donations that were paid for and not yet shown.
const crypto = require("crypto");
const { connectWeb } = require("./connection");
const { encrypt, decrypt } = require("../lib/tokenCrypto");

let settings;
let queues;

async function ensureInitialized() {
  if (settings && queues) return { settings, queues };
  const db = await connectWeb();
  const s = db.collection("DonationMediaSettings");
  const q = db.collection("DonationMediaQueues");
  // A failed createIndex must not fail the request that happened to trigger it (../CLAUDE.md,
  // "A repo's ensureInitialized() must not be able to fail a page render").
  try {
    await Promise.all([
      s.createIndex({ channelId: 1 }, { unique: true }),
      s.createIndex({ playerKey: 1 }, { unique: true, sparse: true }),
      s.createIndex({ panelKey: 1 }, { unique: true, sparse: true }),
      q.createIndex({ channelId: 1 }, { unique: true }),
    ]);
  } catch (err) {
    console.error("[donationMediaRepo] createIndex failed:", err.message);
  }
  settings = s;
  queues = q;
  return { settings, queues };
}

function newKey() {
  return crypto.randomBytes(24).toString("base64url");
}

function tryDecrypt(value) {
  if (!value) return "";
  try {
    return decrypt(value);
  } catch (err) {
    // A changed TOKEN_ENCRYPTION_KEY: the platform reads as "not connected" and the owner pastes
    // the key again, rather than the whole feature failing for the channel.
    console.error("[donationMediaRepo] could not decrypt a stored key:", err.message);
    return "";
  }
}

// The decrypted view of one row: { channelId, channelLogin, playerKey, panelKey, donationAlerts:
// { token, currency } | null, donatello: { userId, widgetId } | null, donatePay: { token, origin }
// | null }. A platform whose secret could not be read is null.
function toConfig(doc) {
  if (!doc) return null;
  const da = doc.donationAlerts && tryDecrypt(doc.donationAlerts.tokenEnc);
  const dnUser = doc.donatello && tryDecrypt(doc.donatello.userIdEnc);
  const dnWidget = doc.donatello && tryDecrypt(doc.donatello.widgetIdEnc);
  const dp = doc.donatePay && tryDecrypt(doc.donatePay.tokenEnc);
  return {
    channelId: doc.channelId,
    channelLogin: doc.channelLogin,
    playerKey: doc.playerKey,
    panelKey: doc.panelKey,
    donationAlerts: da ? { token: da, currency: doc.donationAlerts.currency || null } : null,
    donatello: dnUser && dnWidget ? { userId: dnUser, widgetId: dnWidget } : null,
    donatePay: dp ? { token: dp, origin: doc.donatePay.origin } : null,
    placeholderUrl: doc.placeholderUrl || null,
    updatedAt: doc.updatedAt || null,
  };
}

// The row for a channel, created with fresh link keys the first time the setup page is opened.
async function getOrCreate(channel) {
  const { settings: col } = await ensureInitialized();
  const now = new Date();
  const doc = await col.findOneAndUpdate(
    { channelId: String(channel.channelId) },
    {
      $setOnInsert: { channelId: String(channel.channelId), playerKey: newKey(), panelKey: newKey(), createdAt: now },
      $set: { channelLogin: channel.channelLogin },
    },
    { upsert: true, returnDocument: "after" }
  );
  return toConfig(doc);
}

async function findByChannelId(channelId) {
  const { settings: col } = await ensureInitialized();
  return toConfig(await col.findOne({ channelId: String(channelId) }));
}

// "player" | "panel" and the channel, or null. The OBS pages and their WebSocket authenticate
// with nothing else - no session cookie reaches an OBS browser source.
async function findByKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
  const { settings: col } = await ensureInitialized();
  const doc = await col.findOne(
    { $or: [{ playerKey: key }, { panelKey: key }] },
    { projection: { channelId: 1, channelLogin: 1, playerKey: 1, panelKey: 1, placeholderUrl: 1 } }
  );
  if (!doc) return null;
  return {
    role: doc.playerKey === key ? "player" : "panel",
    channelId: doc.channelId,
    channelLogin: doc.channelLogin,
    placeholderUrl: doc.placeholderUrl || null,
  };
}

// Every channel with at least one platform connected - the manager starts their listeners at boot.
async function listConfigured() {
  const { settings: col } = await ensureInitialized();
  const docs = await col
    .find({ $or: [{ donationAlerts: { $ne: null } }, { donatello: { $ne: null } }, { donatePay: { $ne: null } }] })
    .toArray();
  return docs.map(toConfig).filter((c) => c.donationAlerts || c.donatello || c.donatePay);
}

async function setDonationAlerts(channelId, { token, currency }) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { donationAlerts: { tokenEnc: encrypt(token), currency }, updatedAt: new Date() } }
  );
}

// Currency alone, without re-entering the token.
async function setDonationAlertsCurrency(channelId, currency) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId), donationAlerts: { $ne: null } },
    { $set: { "donationAlerts.currency": currency, updatedAt: new Date() } }
  );
}

async function setDonatello(channelId, { userId, widgetId }) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { donatello: { userIdEnc: encrypt(userId), widgetIdEnc: encrypt(widgetId) }, updatedAt: new Date() } }
  );
}

async function setDonatePay(channelId, { token, origin }) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { donatePay: { tokenEnc: encrypt(token), origin }, updatedAt: new Date() } }
  );
}

// Sets (or, with null, removes) the placeholder picture; resolves to the one it replaced, so the
// caller can delete that file.
async function setPlaceholder(channelId, url) {
  const { settings: col } = await ensureInitialized();
  const update = url ? { $set: { placeholderUrl: url, updatedAt: new Date() } } : { $unset: { placeholderUrl: "" }, $set: { updatedAt: new Date() } };
  const before = await col.findOneAndUpdate({ channelId: String(channelId) }, update, { projection: { placeholderUrl: 1 } });
  return before && before.placeholderUrl ? before.placeholderUrl : null;
}

const PLATFORM_FIELDS = { donationAlerts: "donationAlerts", donatello: "donatello", donatePay: "donatePay" };

async function clearPlatform(channelId, platform) {
  const field = PLATFORM_FIELDS[platform];
  if (!field) throw new Error(`donationMediaRepo.clearPlatform: unknown platform ${platform}`);
  const { settings: col } = await ensureInitialized();
  await col.updateOne({ channelId: String(channelId) }, { $set: { [field]: null, updatedAt: new Date() } });
}

// New player and panel keys: every OBS source and dock using the old links stops working.
async function regenerateKeys(channelId) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { playerKey: newKey(), panelKey: newKey(), updatedAt: new Date() } }
  );
}

async function loadQueue(channelId) {
  const { queues: col } = await ensureInitialized();
  return col.findOne({ channelId: String(channelId) }, { projection: { _id: 0 } });
}

async function saveQueue(channelId, stored) {
  const { queues: col } = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    { $set: { ...stored, channelId: String(channelId), savedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = {
  getOrCreate,
  findByChannelId,
  findByKey,
  listConfigured,
  setDonationAlerts,
  setDonationAlertsCurrency,
  setDonatello,
  setDonatePay,
  clearPlatform,
  regenerateKeys,
  loadQueue,
  saveQueue,
  setPlaceholder,
};
