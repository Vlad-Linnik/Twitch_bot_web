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
const cursorPaging = require("../lib/cursorPaging");

let collection;

// The public feed's order. The cursor (lib/cursorPaging.js) carries createdAt plus _id, so two
// posts created in the same millisecond still page in one stable order.
const FEED_SORT = { name: "newest", key: "createdAt", type: "date", direction: -1 };

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("NewsPosts");
  // Index creation must not be able to fail a page render: the handle is cached above, so a
  // throw here would 500 only the first request after a restart and then silently heal.
  try {
    // The admin list's read path (listAll): newest-first, optionally within one channel.
    await collection.createIndex({ channelLogin: 1, createdAt: -1 });
    // The public feed's read path: the keyset query sorts on _id as the tiebreaker as well,
    // which the index above cannot serve without an in-memory sort.
    await collection.createIndex({ channelLogin: 1, createdAt: -1, _id: -1 });
  } catch (err) {
    console.error("[newsRepo] createIndex failed:", err.message);
  }
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
    commentCount: 0,
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

// create() has always defaulted commentCount to 0, but a post written before that default
// existed (or before the comments feature shipped at all) has no field there whatsoever -
// db/threadStore.js's createComment()/removeComment() $inc it from that missing state just fine
// (Mongo treats a missing numeric field as 0 for $inc), so the FIRST comment/removal silently
// heals it, but a post that has never had one still reads back as `undefined`, which
// `<%= post.commentCount %>` in views/newsPost.ejs/partials/newsCard.ejs renders as "" instead
// of "0". Normalized here, once, rather than a `|| 0` at every call site.
function withCommentCountDefault(doc) {
  if (doc && doc.commentCount === undefined) doc.commentCount = 0;
  return doc;
}

async function getById(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return withCommentCountDefault(await col.findOne({ _id: new ObjectId(id) }));
}

// Public feed read path: one portion of `limit` posts after `cursor` (null = from the top).
// `cursor` is an already-parsed value from cursorPaging.parseCursor - validation is the route's
// job, so a forged cursor is a 400 there rather than something this function has to survive.
async function listPortion(channelLogin, { cursor = null, limit = 10 } = {}) {
  const col = await ensureInitialized();
  const base = { channelLogin: channelLogin.toLowerCase() };
  const rows = await col
    .find(cursorPaging.andFilters(base, cursorPaging.buildAfterFilter(FEED_SORT, cursor)))
    .sort(cursorPaging.sortFor(FEED_SORT))
    .limit(limit + 1)
    .toArray();
  const { items, nextCursor } = cursorPaging.slicePortion(FEED_SORT, rows, limit);
  return { posts: items.map(withCommentCountDefault), nextCursor };
}

// "Back" restore: every post from the top of the feed down to and including `postId`, plus the
// ordinary portion that follows it. The anchor alone is not enough - with nothing below the
// anchor card the page is too short to scroll it back to where it sat on screen. Returns null
// when the post is gone, belongs to another channel, or sits deeper than `max`; the caller then
// keeps an ordinary first portion.
async function listThrough(channelLogin, postId, { max = 240, limit = 10 } = {}) {
  if (!ObjectId.isValid(postId)) return null;
  const col = await ensureInitialized();
  const login = channelLogin.toLowerCase();
  const anchor = await col.findOne({ _id: new ObjectId(postId), channelLogin: login }, { projection: { createdAt: 1 } });
  if (!anchor) return null;

  const anchorCursor = { value: anchor.createdAt, id: anchor._id };
  const base = { channelLogin: login };
  const sort = cursorPaging.sortFor(FEED_SORT);
  const head = await col
    .find(cursorPaging.andFilters(base, cursorPaging.buildThroughFilter(FEED_SORT, anchorCursor)))
    .sort(sort)
    .limit(max + 1)
    .toArray();
  if (head.length > max) return null;

  const tail = await col
    .find(cursorPaging.andFilters(base, cursorPaging.buildAfterFilter(FEED_SORT, anchorCursor)))
    .sort(sort)
    .limit(limit + 1)
    .toArray();
  const { items, nextCursor } = cursorPaging.slicePortion(FEED_SORT, tail, limit);
  return { posts: [...head, ...items].map(withCommentCountDefault), nextCursor };
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

module.exports = { FEED_SORT, create, update, deletePost, getById, listPortion, listThrough, listAll };
