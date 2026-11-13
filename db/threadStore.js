// Discussion threads (nested comments + up/down votes) and heart reactions, for anything with an
// _id that lives on a channel: news posts today, movie and game cards next. One factory, one
// set of collections per section - not one shared Comments collection keyed by
// {targetType, targetId}. That alternative is the same code plus a migration of live NewsComments
// rows and a window at deploy time where the two disagree, to save one argument in a factory call.
// News therefore keeps its collection and field names exactly as they were (`postId`), and no
// stored data changes.
//
//   const store = createThreadStore({
//     items: "NewsPosts", comments: "NewsComments", votes: "NewsCommentVotes",
//     reactions: "NewsReactions", foreignKey: "postId",
//   });
//
// The ITEM collection is only ever touched through its three counters (commentCount, likeCount,
// superlikeCount), kept on the item itself so a feed or grid never has to $group per request.
//
// Comments are soft-deleted (`removed: true`, body and author left intact): replies underneath
// keep a valid parent, and a moderator reviewing the removal still sees what was said. Hiding a
// removed comment from everyone else happens at render time (views/partials/commentThread.ejs).
// lib/commentValidation.js's buildCommentTree nests the flat list this returns.
//
// Votes are a three-state control per user (none/up/down) adjusted by exact delta, so switching a
// vote is one $inc of +/-2. Read-then-write, not atomic: the same user voting from two tabs at once
// can drift the score by one until their next click - a tolerance this site's other counters
// accept too, rather than a transaction over something this low-stakes.
//
// Reactions are independent boolean toggles per type: insert, and on a duplicate key (E11000)
// delete instead - race-safe because the unique index decides.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

// Generous cap, not a pagination boundary - buildCommentTree renders a comment whose parent did
// not make the cut as a top-level one instead of dropping it.
const MAX_COMMENTS_PER_ITEM = 1000;

const REACTION_COUNT_FIELD = { like: "likeCount", superlike: "superlikeCount" };
const REACTION_TYPES = Object.keys(REACTION_COUNT_FIELD);

const toOid = (id) => (id instanceof ObjectId ? id : ObjectId.isValid(id) ? new ObjectId(id) : null);

function createThreadStore({ items, comments, votes, reactions, foreignKey, connect = connectWeb }) {
  if (!items || !comments || !votes || !reactions || !foreignKey) {
    throw new TypeError("createThreadStore: items, comments, votes, reactions and foreignKey are required");
  }

  let handles = null;
  let initializing = null;

  // Index creation is inside a catch on purpose: the handles are cached before it runs, so a throw
  // here would fail only the first request after a restart and then silently heal - an error
  // nobody could find in a log.
  async function init() {
    if (handles) return handles;
    if (!initializing) {
      initializing = (async () => {
        const db = await connect();
        const h = {
          items: db.collection(items),
          comments: db.collection(comments),
          votes: db.collection(votes),
          reactions: db.collection(reactions),
        };
        try {
          await Promise.all([
            // The permalink page's read path: every comment on one item, in one query.
            h.comments.createIndex({ [foreignKey]: 1 }),
            h.votes.createIndex({ commentId: 1, userId: 1 }, { unique: true }),
            h.reactions.createIndex({ [foreignKey]: 1, userId: 1, type: 1 }, { unique: true }),
          ]);
        } catch (err) {
          console.error(`[threadStore:${comments}] createIndex failed:`, err.message);
        }
        handles = h;
        return h;
      })();
    }
    return initializing;
  }

  // --- comments ---------------------------------------------------------------------------

  // `depth` is computed by the caller (0 for a top-level comment, parent.depth + 1 for a reply,
  // rejected before this if it would exceed lib/commentValidation.js's MAX_DEPTH) and stored, so
  // validating a later reply is one lookup of its parent rather than a tree rebuild.
  // authorLogin is kept apart from authorDisplayName: restricting a commenter needs the real login,
  // and a Twitch display name is not guaranteed to match it.
  async function createComment({ itemId, channelLogin, parentId, depth, authorUserId, authorLogin, authorDisplayName, body }) {
    const h = await init();
    const now = new Date();
    const doc = {
      [foreignKey]: toOid(itemId),
      channelLogin: channelLogin.toLowerCase(),
      parentId: parentId ? toOid(parentId) : null,
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
    const result = await h.comments.insertOne(doc);
    await h.items.updateOne({ _id: doc[foreignKey] }, { $inc: { commentCount: 1 } });
    return { ...doc, _id: result.insertedId };
  }

  async function listComments(itemId) {
    const oid = toOid(itemId);
    if (!oid) return [];
    const h = await init();
    return h.comments.find({ [foreignKey]: oid }).limit(MAX_COMMENTS_PER_ITEM).toArray();
  }

  async function getComment(id) {
    const oid = toOid(id);
    if (!oid) return null;
    const h = await init();
    return h.comments.findOne({ _id: oid });
  }

  // Which item a comment belongs to, as a string - the routes compare it against the item in the
  // URL so a tampered id cannot reach into another item's thread.
  function itemIdOf(comment) {
    return comment && comment[foreignKey] ? String(comment[foreignKey]) : null;
  }

  // Soft delete by a moderator. Gives back the comment's slot in the item's commentCount (create
  // took one), or the visible count would include comments only moderators can see. The
  // `removed: false` filter makes it idempotent: a second removal matches nothing and the
  // decrement never runs twice.
  async function removeComment(id, byUserId) {
    const oid = toOid(id);
    if (!oid) return null;
    const h = await init();
    const updated = await h.comments.findOneAndUpdate(
      { _id: oid, removed: false },
      { $set: { removed: true, removedBy: String(byUserId), removedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (updated) await h.items.updateOne({ _id: updated[foreignKey] }, { $inc: { commentCount: -1 } });
    return updated;
  }

  // --- votes -----------------------------------------------------------------------------

  // direction is 1 (up) or -1 (down) - whichever arrow was clicked. Same arrow again undoes it,
  // the other arrow switches it.
  async function voteComment(commentId, userId, direction) {
    if (direction !== 1 && direction !== -1) throw new Error(`invalid vote direction: ${direction}`);
    const oid = toOid(commentId);
    if (!oid) return null;
    const h = await init();
    const uid = String(userId);

    const existing = await h.votes.findOne({ commentId: oid, userId: uid });
    const oldValue = existing ? existing.value : 0;
    let newValue;
    if (!existing) {
      newValue = direction;
      await h.votes.insertOne({ commentId: oid, userId: uid, value: direction, createdAt: new Date() });
    } else if (existing.value === direction) {
      newValue = 0;
      await h.votes.deleteOne({ commentId: oid, userId: uid });
    } else {
      newValue = direction;
      await h.votes.updateOne({ commentId: oid, userId: uid }, { $set: { value: direction } });
    }

    const { score, up, down } = voteDelta(oldValue, newValue);
    const updated = await h.comments.findOneAndUpdate(
      { _id: oid },
      { $inc: { score, upvoteCount: up, downvoteCount: down } },
      { returnDocument: "after" }
    );
    if (!updated) return null;
    return {
      value: newValue,
      score: updated.score,
      upvoteCount: updated.upvoteCount,
      downvoteCount: updated.downvoteCount,
    };
  }

  // Map<commentId string, 1|-1> for the viewer's own arrows across a whole thread, one query.
  async function getUserVotes(commentIds, userId) {
    const oids = commentIds.map(toOid).filter(Boolean);
    if (!oids.length) return new Map();
    const h = await init();
    const docs = await h.votes.find({ commentId: { $in: oids }, userId: String(userId) }).toArray();
    return new Map(docs.map((d) => [String(d.commentId), d.value]));
  }

  // --- reactions -------------------------------------------------------------------------

  // Returns {liked, count} - count is the item's counter for that type, read back from the same
  // atomic $inc, so the route can answer without a second query. null when the item is gone.
  async function toggleReaction(itemId, userId, type) {
    const field = REACTION_COUNT_FIELD[type];
    if (!field) throw new Error(`invalid reaction type: ${type}`);
    const oid = toOid(itemId);
    if (!oid) return null;
    const h = await init();
    const uid = String(userId);
    try {
      await h.reactions.insertOne({ [foreignKey]: oid, userId: uid, type, createdAt: new Date() });
      const updated = await h.items.findOneAndUpdate({ _id: oid }, { $inc: { [field]: 1 } }, { returnDocument: "after" });
      return updated ? { liked: true, count: updated[field] } : null;
    } catch (err) {
      // E11000 = already reacted: this click is the "undo" half of the toggle.
      if (err.code !== 11000) throw err;
      await h.reactions.deleteOne({ [foreignKey]: oid, userId: uid, type });
      const updated = await h.items.findOneAndUpdate({ _id: oid }, { $inc: { [field]: -1 } }, { returnDocument: "after" });
      return updated ? { liked: false, count: updated[field] } : null;
    }
  }

  // Set of "itemId:type" keys for the viewer's own hearts across a page of items, one query.
  async function getUserReactions(itemIds, userId) {
    const oids = itemIds.map(toOid).filter(Boolean);
    if (!oids.length) return new Set();
    const h = await init();
    const docs = await h.reactions.find({ [foreignKey]: { $in: oids }, userId: String(userId) }).toArray();
    return new Set(docs.map((d) => `${d[foreignKey]}:${d.type}`));
  }

  // --- deleting an item ------------------------------------------------------------------

  // Everything hanging off one item: its reactions, its comments and the votes on those comments.
  // Called after the item itself is deleted, so nothing can render the half-deleted state.
  async function deleteAllFor(itemId) {
    const oid = toOid(itemId);
    if (!oid) return;
    const h = await init();
    const commentIds = await h.comments.find({ [foreignKey]: oid }, { projection: { _id: 1 } }).toArray();
    await Promise.all([
      h.reactions.deleteMany({ [foreignKey]: oid }),
      commentIds.length ? h.votes.deleteMany({ commentId: { $in: commentIds.map((c) => c._id) } }) : null,
    ]);
    await h.comments.deleteMany({ [foreignKey]: oid });
  }

  return {
    foreignKey,
    createComment,
    listComments,
    getComment,
    itemIdOf,
    removeComment,
    voteComment,
    getUserVotes,
    toggleReaction,
    getUserReactions,
    deleteAllFor,
  };
}

// The score/up/down counter changes for moving one user's vote from oldValue to newValue
// (each of -1, 0, 1). Pure - exported for the tests.
function voteDelta(oldValue, newValue) {
  return {
    score: newValue - oldValue,
    up: (newValue === 1 ? 1 : 0) - (oldValue === 1 ? 1 : 0),
    down: (newValue === -1 ? 1 : 0) - (oldValue === -1 ? 1 : 0),
  };
}

module.exports = { createThreadStore, voteDelta, REACTION_TYPES, MAX_COMMENTS_PER_ITEM };
