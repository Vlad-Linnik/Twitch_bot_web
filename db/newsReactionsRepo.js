// Heart reactions on news posts (NewsReactions, web db: one doc per {postId, userId, type},
// type "like"|"superlike"). The toggle and the counter bookkeeping on NewsPosts live in
// db/threadStore.js.
const store = require("./newsThreads");

module.exports = {
  toggleReaction: (postId, userId, type) => store.toggleReaction(postId, userId, type),
  getUserReactions: (postIds, userId) => store.getUserReactions(postIds, userId),
  // Reactions, comments and comment votes of a deleted post - see routes/admin.js's news delete.
  deleteAllForPost: (postId) => store.deleteAllFor(postId),
};
