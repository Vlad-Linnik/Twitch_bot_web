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
//  commentCount,
//  suggestion: {userId, login, displayName, note, createdAt} | null   (a viewer's suggestion),
//  votes: {score, up, down}   (counted promote/not-now votes on a suggestion - a cache of
//                              MediaSuggestionVotes, moved by exact deltas like ratings.viewers),
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
    // Same for the search sources' own ids. TMDB numbers films and series separately, so its id
    // is only unique together with its type.
    await collection.createIndex(
      { channelLogin: 1, kind: 1, "external.tmdbType": 1, "external.tmdbId": 1 },
      { unique: true, partialFilterExpression: { "external.tmdbId": { $type: "number" } } }
    );
    await collection.createIndex(
      { channelLogin: 1, kind: 1, "external.shikimoriId": 1 },
      { unique: true, partialFilterExpression: { "external.shikimoriId": { $type: "number" } } }
    );
    // Games: one card per Steam app and per Twitch category on a channel.
    await collection.createIndex(
      { channelLogin: 1, kind: 1, "external.steamAppId": 1 },
      { unique: true, partialFilterExpression: { "external.steamAppId": { $type: "number" } } }
    );
    await collection.createIndex(
      { channelLogin: 1, kind: 1, "external.twitchCategoryId": 1 },
      { unique: true, partialFilterExpression: { "external.twitchCategoryId": { $type: "string" } } }
    );
    // The nightly IMDb rating sync looks cards up by IMDb id across every channel.
    await collection.createIndex({ "external.imdbId": 1 }, { partialFilterExpression: { "external.imdbId": { $type: "string" } } });
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
    gameState: doc.gameState || null,
    ratings: { streamer: doc.streamerRating ?? null, viewers: { sum: 0, count: 0 }, external: null },
    review: doc.review || null,
    commentCount: 0,
    suggestion: doc.suggestion || null,
    votes: { score: 0, up: 0, down: 0 },
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

// Every card of one channel, kind and status (or list of statuses), for the grid to filter and
// sort in memory.
async function listForGrid(channelLogin, kind, status) {
  const col = await ensureInitialized();
  const statusFilter = Array.isArray(status) ? { $in: status } : status;
  return col
    .find({ channelLogin: channelLogin.toLowerCase(), kind, status: statusFilter }, { projection: GRID_PROJECTION })
    .toArray();
}

// What a duplicate check compares against: every card of the channel and kind, in every status,
// with only the fields lib/mediaSuggestions.js's findDuplicate reads.
async function listForDuplicateCheck(channelLogin, kind) {
  const col = await ensureInitialized();
  return col
    .find(
      { channelLogin: channelLogin.toLowerCase(), kind },
      { projection: { title: 1, originalTitle: 1, year: 1, status: 1, external: 1, rejectReason: 1 } }
    )
    .toArray();
}

// One person's suggestions still waiting for a decision - the per-person ceiling.
async function countOpenSuggestions(channelLogin, kind, userId) {
  const col = await ensureInitialized();
  return col.countDocuments({ channelLogin: channelLogin.toLowerCase(), kind, status: "suggested", "suggestion.userId": String(userId) });
}

// A status change by levels 0-2 (accept / reject / reopen). `expect` is the status the decision was
// made against: if someone else decided in the meantime, nothing is written and null comes back.
async function decide(id, { expect, status, decidedBy, rejectReason = null, approvePoster = false }) {
  const oid = toOid(id);
  if (!oid) return null;
  const col = await ensureInitialized();
  const now = new Date();
  const set = { status, decidedBy, decidedAt: now, rejectReason, updatedAt: now };
  if (status === "done") set.doneAt = now;
  // Accepting a suggestion is also approving the cover its author uploaded.
  if (approvePoster) set["poster.approved"] = true;
  return col.findOneAndUpdate({ _id: oid, status: { $in: [].concat(expect) } }, { $set: set }, { returnDocument: "after" });
}

async function incSuggestionVotes(id, { score, up, down }) {
  const oid = toOid(id);
  if (!oid || (score === 0 && up === 0 && down === 0)) return;
  const col = await ensureInitialized();
  await col.updateOne({ _id: oid }, { $inc: { "votes.score": score, "votes.up": up, "votes.down": down } });
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

// Every distinct IMDb id on any card - the set the nightly dataset pass keeps lines for.
async function distinctImdbIds() {
  const col = await ensureInitialized();
  return col.distinct("external.imdbId", { "external.imdbId": { $type: "string" } });
}

// Writes the IMDb ratings found by one dataset pass: Map<tconst, {value, votes}>. One updateMany
// per id (an id can sit on several channels' cards), batched.
async function setImdbRatings(ratings, fetchedAt = new Date()) {
  if (!ratings.size) return 0;
  const col = await ensureInitialized();
  const ops = [...ratings].map(([imdbId, { value, votes }]) => ({
    updateMany: {
      filter: { "external.imdbId": imdbId },
      update: { $set: { "ratings.external": { source: "imdb", value, votes, fetchedAt } } },
    },
  }));
  const result = await col.bulkWrite(ops, { ordered: false });
  return result.modifiedCount;
}

// Every distinct Steam app id on any game card - the set the daily review pass asks Steam about.
async function distinctSteamAppIds() {
  const col = await ensureInitialized();
  return col.distinct("external.steamAppId", { kind: "game", "external.steamAppId": { $type: "number" } });
}

// Writes one source's outside ratings: Map<id, {value, votes}>, matched on `field` (e.g.
// "external.steamAppId"). One updateMany per id, batched.
async function setExternalRatings(source, field, ratings, fetchedAt = new Date()) {
  if (!ratings.size) return 0;
  const col = await ensureInitialized();
  const ops = [...ratings].map(([id, { value, votes }]) => ({
    updateMany: { filter: { [field]: id }, update: { $set: { "ratings.external": { source, value, votes, fetchedAt } } } },
  }));
  const result = await col.bulkWrite(ops, { ordered: false });
  return result.modifiedCount;
}

// /admin/media's counters.
async function sourceStats() {
  const col = await ensureInitialized();
  const [total, withImdb, withRating, games, withSteam, withSteamRating] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ "external.imdbId": { $type: "string" } }),
    col.countDocuments({ "ratings.external.source": "imdb" }),
    col.countDocuments({ kind: "game" }),
    col.countDocuments({ kind: "game", "external.steamAppId": { $type: "number" } }),
    col.countDocuments({ "ratings.external.source": "steam" }),
  ]);
  return { total, withImdb, withRating, games, withSteam, withSteamRating };
}

module.exports = {
  create,
  update,
  getById,
  listForGrid,
  countByStatus,
  incViewerRatings,
  deleteItem,
  listForDuplicateCheck,
  countOpenSuggestions,
  decide,
  incSuggestionVotes,
  distinctImdbIds,
  setImdbRatings,
  distinctSteamAppIds,
  setExternalRatings,
  sourceStats,
};
