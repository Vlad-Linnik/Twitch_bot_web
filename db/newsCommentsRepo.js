// Reddit-style nested comments on news posts. Web-only collection, alongside NewsPosts/
// NewsReactions. One doc per comment: {postId, channelLogin, parentId (null for a top-level
// comment), authorUserId, authorLogin, authorDisplayName, body, score, upvoteCount,
// downvoteCount, removed (soft-delete flag), removedBy, removedAt, createdAt, updatedAt}.
//
// authorLogin is stored separately from authorDisplayName (the latter is what's SHOWN in the
// thread) specifically so routes/news.js's /restrict action has a real Twitch login to hand to
// db/newsCommentBansRepo.js's userLogin field - display name and login can differ in case or
// entirely (a Twitch display name isn't guaranteed to match the login), so the two must not be
// conflated.
//
// Soft-delete only: a removed comment's doc stays in place (`removed: true`, body/author left
// intact) so replies underneath it keep a valid parent to attach to - a hard delete would either
// orphan an entire subtree or force a destructive cascade that also wipes other people's
// unrelated replies. body/author are deliberately NOT blanked: a site admin (tier 0) still needs
// to see what was actually posted and by whom to review the removal, so hiding a removed
// comment's content is done at display time only (views/partials/commentThread.ejs shows it to
// admins with a "deleted" badge, and hides it entirely from everyone else) rather than by
// destroying the data. lib/commentValidation.js's buildCommentTree() is what actually nests the
// flat list this repo returns into a tree, and treats "removed" as a display flag, not a
// structural one.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let commentsCollection;
let postsCollection;

async function ensureInitialized() {
  if (commentsCollection) return { comments: commentsCollection, posts: postsCollection };
  const db = await connectWeb();
  commentsCollection = db.collection("NewsComments");
  postsCollection = db.collection("NewsPosts");
  // The permalink page's read path: every comment on one post, in one query.
  await commentsCollection.createIndex({ postId: 1 });
  return { comments: commentsCollection, posts: postsCollection };
}

// Generous cap, not a real pagination boundary - see buildCommentTree's comment on why a comment
// whose parent didn't make the cut safely falls back to rendering as a top-level comment instead
// of vanishing.
const MAX_COMMENTS_PER_POST = 1000;

// `depth` is caller-computed (routes/news.js: 0 for a top-level comment, parent.depth + 1 for a
// reply, rejected before reaching here if it would exceed lib/commentValidation.js's MAX_DEPTH) -
// stored directly so validating a FUTURE reply's depth is one getById() on the parent, not a
// full-tree rebuild just to answer "how deep is this one comment".
async function create({ postId, channelLogin, parentId, depth, authorUserId, authorLogin, authorDisplayName, body }) {
  const { comments, posts } = await ensureInitialized();
  const now = new Date();
  const doc = {
    postId: new ObjectId(postId),
    channelLogin: channelLogin.toLowerCase(),
    parentId: parentId ? new ObjectId(parentId) : null,
    depth,
    authorUserId: String(authorUserId),
    authorLogin,
    authorDisplayName,
    body,
    score: 0,
    upvoteCount: 0,
    downvoteCount: 0,
    removed: false,
    removedBy: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const result = await comments.insertOne(doc);
  await posts.updateOne({ _id: new ObjectId(postId) }, { $inc: { commentCount: 1 } });
  return { ...doc, _id: result.insertedId };
}

// Flat list, newest-parent-agnostic - lib/commentValidation.js's buildCommentTree does the
// nesting/sorting. Capped defensively; see MAX_COMMENTS_PER_POST.
async function listForPost(postId) {
  const { comments } = await ensureInitialized();
  return comments.find({ postId: new ObjectId(postId) }).limit(MAX_COMMENTS_PER_POST).toArray();
}

async function getById(id) {
  if (!ObjectId.isValid(id)) return null;
  const { comments } = await ensureInitialized();
  return comments.findOne({ _id: new ObjectId(id) });
}

// Admin-only (tier-0, routes/news.js). Blanks the displayed content but keeps the doc so replies
// underneath it keep a valid parent - see the file-level comment on why this isn't a hard delete.
// Does NOT keep its slot in the post's commentCount, though: create() increments commentCount on
// the way in, so this mirrors it with a decrement on the way out, otherwise the displayed count
// (views/newsPost.ejs's heading, partials/newsCard.ejs's feed badge) would count comments that
// are no longer visible to anyone but an admin. The `removed: false` filter makes this idempotent
// (a comment can never be removed twice, so there's no un-remove action to worry about double-
// counting against) - if the comment's already removed the filter simply doesn't match and the
// $inc below never runs.
async function removeByAdmin(id, adminUserId) {
  if (!ObjectId.isValid(id)) return null;
  const { comments, posts } = await ensureInitialized();
  const updated = await comments.findOneAndUpdate(
    { _id: new ObjectId(id), removed: false },
    { $set: { removed: true, removedBy: String(adminUserId), removedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (updated) {
    await posts.updateOne({ _id: updated.postId }, { $inc: { commentCount: -1 } });
  }
  return updated;
}

module.exports = { create, listForPost, getById, removeByAdmin };
