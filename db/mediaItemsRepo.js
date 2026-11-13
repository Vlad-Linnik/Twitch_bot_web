// A channel's movie cards (games join under kind "game"), MediaItems in the web db - the bot
// never reads them. One collection for both kinds because they share nine tenths of their shape:
// cover, ratings, review, status, discussion.
//
// {_id, channelLogin (no '#'), kind: 'movie'|'game', status: 'suggested'|'accepted'|'done'|'rejected',
//  title, originalTitle, year, searchKey, mediaType: 'film'|'series'|'anime'|null,
//  external: {imdbId?, ...}, poster: {url, blurUrl, width, height, source} | null, nsfw,
//  recordingUrl, progress: {done, total, unit} | null,
//  ratings: {streamer: 1..10|null, viewers: {sum, count}, external: null},
//  review: {bodyRaw, bodyHtml, excerpt, authorUserId, updatedAt} | null,
//  likeCount, superlikeCount, commentCount, suggestion: null,
//  createdBy: {userId, login, level}, doneAt, createdAt, updatedAt}
//
// ratings.viewers is a cache: MediaRatings is the source of truth, and this pair is moved by the
// exact delta of each rating write (lib/mediaValidation.js's viewerRatingDelta). The average is
// computed on read, never stored.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("MediaItems");
  // In a catch: the handle is cached above, so a throw would fail only the first request after a
  // restart and then silently heal.
  try {
    // The grid's read path. Sorting by a rating happens in memory over this prefix - a channel has
    // hundreds of cards, not tens of thousands, and an index per sortable field would be paid on
    // every write.
    await collection.createIndex({ channelLogin: 1, kind: 1, status: 1, createdAt: -1, _id: -1 });
    // The same film twice on one channel. Partial: only cards that have the external id.
    await collection.createIndex(
      { channelLogin: 1, kind: 1, "external.imdbId": 1 },
      { unique: true, partialFilterExpression: { "external.imdbId": { $type: "string" } } }
    );
  } catch (err) {
    console.error("[mediaItemsRepo] createIndex failed:", err.message);
  }
  return collection;
}

const toOid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Everything the grid draws, without the review body (the grid uses the excerpt).
const GRID_PROJECTION = { "review.bodyRaw": 0, "review.bodyHtml": 0 };

async function create(doc) {
  const col = await ensureInitialized();
  const now = new Date();
  const full = {
    channelLogin: doc.channelLogin.toLowerCase(),
    kind: doc.kind,
    status: doc.status,
    title: doc.title,
    originalTitle: doc.originalTitle,
    year: doc.year,
    searchKey: doc.searchKey,
    mediaType: doc.mediaType,
    external: doc.external || {},
    poster: doc.poster || null,
    nsfw: Boolean(doc.nsfw),
    recordingUrl: doc.recordingUrl || null,
    progress: doc.progress || null,
    ratings: { streamer: doc.streamerRating ?? null, viewers: { sum: 0, count: 0 }, external: null },
    review: doc.review || null,
    likeCount: 0,
    superlikeCount: 0,
    commentCount: 0,
    suggestion: null,
    createdBy: doc.createdBy,
    doneAt: doc.status === "done" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await col.insertOne(full);
  return { ...full, _id: result.insertedId };
}

// `set` is a flat $set map built by the route (it knows which fields this editor may write).
async function update(id, set) {
  const oid = toOid(id);
  if (!oid) return null;
  const col = await ensureInitialized();
  return col.findOneAndUpdate({ _id: oid }, { $set: { ...set, updatedAt: new Date() } }, { returnDocument: "after" });
}

async function getById(id) {
  const oid = toOid(id);
  if (!oid) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id: oid });
}

// Every card of one channel, kind and status, for the grid to filter and sort in memory.
async function listForGrid(channelLogin, kind, status) {
  const col = await ensureInitialized();
  return col
    .find({ channelLogin: channelLogin.toLowerCase(), kind, status }, { projection: GRID_PROJECTION })
    .toArray();
}

// How many cards each status tab holds - the counts on the grid's tabs.
async function countByStatus(channelLogin, kind) {
  const col = await ensureInitialized();
  const rows = await col
    .aggregate([{ $match: { channelLogin: channelLogin.toLowerCase(), kind } }, { $group: { _id: "$status", n: { $sum: 1 } } }])
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

async function incViewerRatings(id, { sum, count }) {
  const oid = toOid(id);
  if (!oid || (sum === 0 && count === 0)) return;
  const col = await ensureInitialized();
  await col.updateOne({ _id: oid }, { $inc: { "ratings.viewers.sum": sum, "ratings.viewers.count": count } });
}

async function deleteItem(id) {
  const oid = toOid(id);
  if (!oid) return null;
  const col = await ensureInitialized();
  return col.findOneAndDelete({ _id: oid });
}

module.exports = { create, update, getById, listForGrid, countByStatus, incViewerRatings, deleteItem };
