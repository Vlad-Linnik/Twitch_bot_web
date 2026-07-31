// Per-user reactions on news posts (two independent heart toggles: "like"/"superlike", see
// public/js/news-reactions.js). Lives in the web-only database, alongside NewsPosts. One doc
// per (postId, userId, type), unique compound index - toggling is a race-safe two-step
// insert/delete, same idiom as db/gameScoresRepo.js's submitScore/applyEloDelta: try the
// insert, and on a duplicate key (E11000) delete instead. The matching NewsPosts counter is
// incremented/decremented alongside so the feed's read path never has to $group/count reactions
// per request.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let reactionsCollection;
let postsCollection;

async function ensureInitialized() {
  if (reactionsCollection) return { reactions: reactionsCollection, posts: postsCollection };
  const db = await connectWeb();
  reactionsCollection = db.collection("NewsReactions");
  postsCollection = db.collection("NewsPosts");
  await reactionsCollection.createIndex({ postId: 1, userId: 1, type: 1 }, { unique: true });
  return { reactions: reactionsCollection, posts: postsCollection };
}

const COUNT_FIELD = { like: "likeCount", superlike: "superlikeCount" };

// Toggles one user's reaction of one type on one post. Returns {liked, count} - count is the
// post's up-to-date counter for that reaction type, read back from the atomic $inc so the
// caller (routes/news.js's react endpoint) can answer the client without a second query.
async function toggleReaction(postId, userId, type) {
  const field = COUNT_FIELD[type];
  if (!field) throw new Error(`invalid reaction type: ${type}`);
  if (!ObjectId.isValid(postId)) return null;

  const { reactions, posts } = await ensureInitialized();
  const oid = new ObjectId(postId);
  const uid = String(userId);

  try {
    await reactions.insertOne({ postId: oid, userId: uid, type, createdAt: new Date() });
    const updated = await posts.findOneAndUpdate({ _id: oid }, { $inc: { [field]: 1 } }, { returnDocument: "after" });
    return updated ? { liked: true, count: updated[field] } : null;
  } catch (err) {
    // E11000 = already reacted - this click is the "undo" half of the toggle.
    if (err.code !== 11000) throw err;
    await reactions.deleteOne({ postId: oid, userId: uid, type });
    const updated = await posts.findOneAndUpdate({ _id: oid }, { $inc: { [field]: -1 } }, { returnDocument: "after" });
    return updated ? { liked: false, count: updated[field] } : null;
  }
}

// Batch lookup for rendering the viewer's own filled/empty heart state across a page of posts -
// one query for the whole feed rather than one per card. Returns a Set of "postId:type" keys.
async function getUserReactions(postIds, userId) {
  if (!postIds.length) return new Set();
  const { reactions } = await ensureInitialized();
  const oids = postIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  const docs = await reactions.find({ postId: { $in: oids }, userId: String(userId) }).toArray();
  return new Set(docs.map((d) => `${d.postId}:${d.type}`));
}

// Cleanup companion to newsRepo.deletePost - a deleted post's reaction docs are unreachable
// (nothing ever queries NewsReactions without a live post to render), but leaving them behind
// would let a recreated ObjectId collide in theory and silently inherit old reactions in
// practice never happens (ObjectIds aren't reused), so this is just tidiness, not correctness.
async function deleteAllForPost(postId) {
  if (!ObjectId.isValid(postId)) return;
  const { reactions } = await ensureInitialized();
  await reactions.deleteMany({ postId: new ObjectId(postId) });
}

module.exports = { toggleReaction, getUserReactions, deleteAllForPost };
