// Nested comments on news posts (NewsComments, web db). The logic - soft delete, commentCount
// bookkeeping, the per-post cap - lives in db/threadStore.js; this keeps the names the news
// routes have always called. Document shape: {postId, channelLogin, parentId, depth,
// authorUserId, authorLogin, authorDisplayName, body, score, upvoteCount, downvoteCount,
// removed, removedBy, removedAt, createdAt, updatedAt}.
const store = require("./newsThreads");

module.exports = {
  create: ({ postId, ...rest }) => store.createComment({ itemId: postId, ...rest }),
  listForPost: (postId) => store.listComments(postId),
  getById: (id) => store.getComment(id),
  // Moderation is open to levels 0-2 (routes/news.js); the name records who CAN remove, not who did.
  removeByModerator: (id, userId) => store.removeComment(id, userId),
  postIdOf: (comment) => store.itemIdOf(comment),
};
