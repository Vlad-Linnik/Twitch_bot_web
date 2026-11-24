// Web-only (the bot never reads these - see ../CLAUDE.md's shared-collections table): the
// donation media feature's two collections.
//
// DonationMediaSettings - one row per channel, written from the setup page:
//   { channelId, channelLogin,
//     playerKey, panelKey,                       the secrets in the OBS links (see below)
//     donationAlerts: { tokenEnc, currency },
//     donatello:      { userIdEnc, widgetIdEnc },
//     donatePay:      { tokenEnc, origin },
//     placeholders: [{ url, thumb }],            the channel's own placeholder pictures
//     placeholderUrl,                            the one picked last; absent or null = built-in
//                                                (lib/donationMediaPlaceholder.js)
//     buttons: { theme, custom },                the queue panel's icon theme
//                                                (lib/donationMediaIcons.js)
//     historyLimit,                              how many finished donations the queue keeps
//     createdAt, updatedAt }
// The platform credentials are encrypted at rest (lib/tokenCrypto.js), like the owner refresh
// tokens: each of them reads the streamer's donations, donor names included. The two link keys are
// stored as they are, because they are looked up by value on every OBS connection and shown back
// to the owner on the setup page; what they unlock is this channel's player and queue panel, and
// the setup page replaces them with one button.
//
// DonationMediaQueues - one row per channel, the queue itself (lib/donationMediaQueue.js's
// toStored()), so a deploy does not throw away donations that were paid for and not yet shown.
//
// DonationMediaEasterEggs - global, not per channel, edited by the site admin only:
//   { videoId, icons: { slot: [icon] }, note, updatedAt, by } - while that video plays, those
//   panel buttons wear those icons (lib/donationMediaIcons.js normalizeEgg).
const crypto = require("crypto");
const { connectWeb } = require("./connection");
const { encrypt, decrypt } = require("../lib/tokenCrypto");
const { normalizePlaceholders, MAX_PLACEHOLDERS } = require("../lib/donationMediaPlaceholder");
const { normalizeButtons, clampHistoryLimit, normalizeEgg, HISTORY_MAX } = require("../lib/donationMediaIcons");

let settings;
let queues;
let eggs;

async function ensureInitialized() {
  if (settings && queues && eggs) return { settings, queues, eggs };
  const db = await connectWeb();
  const s = db.collection("DonationMediaSettings");
  const q = db.collection("DonationMediaQueues");
  const e = db.collection("DonationMediaEasterEggs");
  // A failed createIndex must not fail the request that happened to trigger it (../CLAUDE.md,
  // "A repo's ensureInitialized() must not be able to fail a page render").
  try {
    await Promise.all([
      s.createIndex({ channelId: 1 }, { unique: true }),
      s.createIndex({ playerKey: 1 }, { unique: true, sparse: true }),
      s.createIndex({ panelKey: 1 }, { unique: true, sparse: true }),
      q.createIndex({ channelId: 1 }, { unique: true }),
      e.createIndex({ videoId: 1 }, { unique: true }),
    ]);
  } catch (err) {
    console.error("[donationMediaRepo] createIndex failed:", err.message);
  }
  settings = s;
  queues = q;
  eggs = e;
  return { settings, queues, eggs };
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
    ...normalizePlaceholders(doc),
    buttons: normalizeButtons(doc.buttons),
    historyLimit: Number.isFinite(doc.historyLimit) ? clampHistoryLimit(doc.historyLimit) : HISTORY_MAX,
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
    { projection: { channelId: 1, channelLogin: 1, playerKey: 1, panelKey: 1, placeholderUrl: 1, placeholders: 1 } }
  );
  if (!doc) return null;
  return {
    role: doc.playerKey === key ? "player" : "panel",
    channelId: doc.channelId,
    channelLogin: doc.channelLogin,
    placeholderUrl: normalizePlaceholders(doc).placeholderUrl,
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

// A row from when a channel had a single picture gets its list, so the writes below have one to
// change.
async function ensurePlaceholderList(col, channelId) {
  await col.updateOne({ channelId, placeholders: { $exists: false } }, [
    { $set: { placeholders: { $cond: [{ $ifNull: ["$placeholderUrl", false] }, [{ url: "$placeholderUrl" }], []] } } },
  ]);
}

// Adds a picture; a channel's first one is also the one picked. False when the list is full.
async function addPlaceholder(channelId, { url, thumb }) {
  const { settings: col } = await ensureInitialized();
  const id = String(channelId);
  await ensurePlaceholderList(col, id);
  const entry = { url, thumb };
  const set = { updatedAt: new Date() };
  const first = await col.updateOne({ channelId: id, placeholders: { $size: 0 } }, { $push: { placeholders: entry }, $set: { ...set, placeholderUrl: url } });
  if (first.modifiedCount) return true;
  const added = await col.updateOne(
    { channelId: id, [`placeholders.${MAX_PLACEHOLDERS - 1}`]: { $exists: false } },
    { $push: { placeholders: entry }, $set: set }
  );
  return added.modifiedCount > 0;
}

// Removes a picture; if it was the one picked, the built-in card is. Resolves to the removed
// { url, thumb }, so the caller can delete its files, or null.
async function removePlaceholder(channelId, url) {
  const { settings: col } = await ensureInitialized();
  const id = String(channelId);
  await ensurePlaceholderList(col, id);
  const before = await col.findOneAndUpdate(
    { channelId: id, "placeholders.url": url },
    [
      {
        $set: {
          placeholders: { $filter: { input: "$placeholders", cond: { $ne: ["$$this.url", { $literal: url }] } } },
          placeholderUrl: { $cond: [{ $eq: ["$placeholderUrl", { $literal: url }] }, null, "$placeholderUrl"] },
          updatedAt: new Date(),
        },
      },
    ],
    { projection: { placeholders: 1 } }
  );
  return (before && before.placeholders.find((p) => p.url === url)) || null;
}

// Picks one of the channel's pictures, or (null) the built-in card. A picture removed meanwhile is
// not picked.
async function selectPlaceholder(channelId, url) {
  const { settings: col } = await ensureInitialized();
  const id = String(channelId);
  await ensurePlaceholderList(col, id);
  await col.updateOne(url ? { channelId: id, "placeholders.url": url } : { channelId: id }, { $set: { placeholderUrl: url } });
}

// The panel's icon theme (already normalized by the caller); resolves to the one it replaced, so
// uploads it no longer uses can be deleted.
async function setButtons(channelId, buttons) {
  const { settings: col } = await ensureInitialized();
  const before = await col.findOneAndUpdate(
    { channelId: String(channelId) },
    { $set: { buttons: normalizeButtons(buttons), updatedAt: new Date() } },
    { projection: { buttons: 1 } }
  );
  return normalizeButtons(before && before.buttons);
}

async function setHistoryLimit(channelId, value) {
  const { settings: col } = await ensureInitialized();
  await col.updateOne({ channelId: String(channelId) }, { $set: { historyLimit: clampHistoryLimit(value), updatedAt: new Date() } });
}

// --- Easter eggs (global) -------------------------------------------------------------------------

async function listEggs() {
  const { eggs: col } = await ensureInitialized();
  const docs = await col.find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).toArray();
  return docs.map((d) => ({ ...normalizeEgg(d), updatedAt: d.updatedAt || null, by: d.by || null })).filter((d) => d.videoId);
}

// Returns the egg as saved, or null when it is not a valid one.
async function saveEgg(egg, by) {
  const clean = normalizeEgg(egg);
  if (!clean) return null;
  const { eggs: col } = await ensureInitialized();
  await col.updateOne({ videoId: clean.videoId }, { $set: { ...clean, updatedAt: new Date(), by: by || null } }, { upsert: true });
  return clean;
}

// Resolves to the removed egg (for its uploads), or null.
async function deleteEgg(videoId) {
  const { eggs: col } = await ensureInitialized();
  return col.findOneAndDelete({ videoId: String(videoId) }, { projection: { _id: 0 } });
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
  addPlaceholder,
  removePlaceholder,
  selectPlaceholder,
  setButtons,
  setHistoryLimit,
  listEggs,
  saveEgg,
  deleteEgg,
};
