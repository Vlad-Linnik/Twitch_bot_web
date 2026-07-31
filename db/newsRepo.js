// Per-channel news posts (/<channel>/news, admin-authored via /admin/news). Lives in the
// web-only database (connectWeb) - the bot never needs this content, same reasoning as
// GameScores/SettingsChangeLog. One doc per post:
// {channelLogin, title, bodyFormat: 'markdown'|'html', bodyRaw, bodyHtml, imageUrl,
//  imageWidth, imageHeight, likeCount, superlikeCount, authorUserId, authorDisplayName,
//  createdAt, updatedAt}.
// bodyHtml is the sanitized render (lib/newsValidation.js's renderBody), computed once at
// write time so the public feed's read path never re-renders/re-sanitizes per request.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("NewsPosts");
  // The feed's read path: newest-first within one channel.
  await collection.createIndex({ channelLogin: 1, createdAt: -1 });
  return collection;
}

async function create({
  channelLogin,
  title,
  bodyFormat,
  bodyRaw,
  bodyHtml,
  imageUrl,
  imageWidth,
  imageHeight,
  authorUserId,
  authorDisplayName,
}) {
  const col = await ensureInitialized();
  const now = new Date();
  const doc = {
    channelLogin: channelLogin.toLowerCase(),
    title,
    bodyFormat,
    bodyRaw,
    bodyHtml,
    imageUrl,
    imageWidth,
    imageHeight,
    likeCount: 0,
    superlikeCount: 0,
    authorUserId: String(authorUserId),
    authorDisplayName,
    createdAt: now,
    updatedAt: now,
  };
  const result = await col.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// image* fields are only passed when the admin uploaded a replacement - editing without a new
// file keeps the existing hero image untouched (see routes/admin.js's news edit handler).
async function update(id, { title, bodyFormat, bodyRaw, bodyHtml, imageUrl, imageWidth, imageHeight }) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  const set = { title, bodyFormat, bodyRaw, bodyHtml, updatedAt: new Date() };
  if (imageUrl) Object.assign(set, { imageUrl, imageWidth, imageHeight });
  return col.findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: "after" });
}

// Returns the deleted doc (if any) so the caller can best-effort unlink its stored image file.
async function deletePost(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return col.findOneAndDelete({ _id: new ObjectId(id) });
}

async function getById(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id: new ObjectId(id) });
}

// Public feed read path. Same count-then-find, clamp-page-to-totalPages pagination as
// db/statsRepo.js's getRecentModActions.
async function listByChannel(channelLogin, { page = 1, limit = 10 } = {}) {
  const col = await ensureInitialized();
  const filter = { channelLogin: channelLogin.toLowerCase() };
  const total = await col.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(Math.max(1, page), totalPages);

  const posts = await col
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((clampedPage - 1) * limit)
    .limit(limit)
    .toArray();

  return { posts, total, totalPages, page: clampedPage };
}

// Admin list (/admin/news) - every channel by default, or narrowed to one via channelLogin.
async function listAll({ page = 1, limit = 20, channelLogin = null } = {}) {
  const col = await ensureInitialized();
  const filter = channelLogin ? { channelLogin: channelLogin.toLowerCase() } : {};
  const total = await col.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(Math.max(1, page), totalPages);

  const posts = await col
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((clampedPage - 1) * limit)
    .limit(limit)
    .toArray();

  return { posts, total, totalPages, page: clampedPage };
}

module.exports = { create, update, deletePost, getById, listByChannel, listAll };
