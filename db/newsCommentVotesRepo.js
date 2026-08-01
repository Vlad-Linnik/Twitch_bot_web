// Reddit-style up/down voting on news comments. Web-only collection, alongside NewsComments. One
// doc per (commentId, userId): {commentId, userId, value: 1|-1, createdAt}, unique compound index.
//
// Unlike newsReactionsRepo's toggle (two independent boolean reactions), a vote is a single
// three-state control per user: none -> up, none -> down, up -> none (click up again), up -> down
// (click down while upvoted), and the mirror image. voteComment() below reads the existing vote,
// decides the resulting value, and adjusts the comment's score/upvoteCount/downvoteCount by the
// exact delta between old and new - so switching a vote is one $inc of +/-2, not a separate
// remove-then-add pair (which would transiently show the wrong score to a concurrent reader).
//
// This has a narrow race window (read-then-write, not a single atomic op) if the SAME user
// double-clicks or votes from two tabs at once - worst case the score drifts by one vote's worth
// until their next click self-corrects it. Same tolerance this app's other counters accept (see
// db/gameScoresRepo.js's own comments) rather than reaching for a transaction over something this
// low-stakes.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

let votesCollection;
let commentsCollection;

async function ensureInitialized() {
  if (votesCollection) return { votes: votesCollection, comments: commentsCollection };
  const db = await connectWeb();
  votesCollection = db.collection("NewsCommentVotes");
  commentsCollection = db.collection("NewsComments");
  await votesCollection.createIndex({ commentId: 1, userId: 1 }, { unique: true });
  return { votes: votesCollection, comments: commentsCollection };
}

// direction is 1 (upvote) or -1 (downvote) - whichever arrow the viewer clicked.
async function voteComment(commentId, userId, direction) {
  if (direction !== 1 && direction !== -1) throw new Error(`invalid vote direction: ${direction}`);
  if (!ObjectId.isValid(commentId)) return null;

  const { votes, comments } = await ensureInitialized();
  const oid = new ObjectId(commentId);
  const uid = String(userId);

  const existing = await votes.findOne({ commentId: oid, userId: uid });
  const oldValue = existing ? existing.value : 0;
  let newValue;

  if (!existing) {
    newValue = direction;
    await votes.insertOne({ commentId: oid, userId: uid, value: direction, createdAt: new Date() });
  } else if (existing.value === direction) {
    newValue = 0; // clicking the same arrow again undoes it
    await votes.deleteOne({ commentId: oid, userId: uid });
  } else {
    newValue = direction; // clicking the other arrow switches it
    await votes.updateOne({ commentId: oid, userId: uid }, { $set: { value: direction } });
  }

  const scoreDelta = newValue - oldValue;
  const upDelta = (newValue === 1 ? 1 : 0) - (oldValue === 1 ? 1 : 0);
  const downDelta = (newValue === -1 ? 1 : 0) - (oldValue === -1 ? 1 : 0);

  const updated = await comments.findOneAndUpdate(
    { _id: oid },
    { $inc: { score: scoreDelta, upvoteCount: upDelta, downvoteCount: downDelta } },
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

// Batch lookup for rendering the viewer's own vote arrows across a whole comment thread in one
// query - returns Map<commentId(string), 1|-1>.
async function getUserVotes(commentIds, userId) {
  if (!commentIds.length) return new Map();
  const { votes } = await ensureInitialized();
  const oids = commentIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  const docs = await votes.find({ commentId: { $in: oids }, userId: String(userId) }).toArray();
  return new Map(docs.map((d) => [String(d.commentId), d.value]));
}

module.exports = { voteComment, getUserVotes };
