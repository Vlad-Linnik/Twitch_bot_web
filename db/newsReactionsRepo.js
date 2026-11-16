// Heart reactions on news posts (NewsReactions, web db: one doc per {postId, userId, type},
// type "like"|"superlike"). The toggle and the counter bookkeeping on NewsPosts live in
// db/threadStore.js.
const store = require("./newsThreads");
const notificationsRepo = require("./notificationsRepo");

module.exports = {
  toggleReaction: (postId, userId, type) => store.toggleReaction(postId, userId, type),
  getUserReactions: (postIds, userId) => store.getUserReactions(postIds, userId),
  // Reactions, comments and comment votes of a deleted post - see routes/admin.js's news delete.
  // Reply notifications on the post's comments go with them (db/notificationsRepo.js).
  deleteAllForPost: (postId) => Promise.all([store.deleteAllFor(postId), notificationsRepo.removeForItem("news", postId)]),
};
