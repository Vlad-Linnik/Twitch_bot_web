// Up/down votes on news comments (NewsCommentVotes, web db: one doc per {commentId, userId},
// value 1|-1). The three-state logic lives in db/threadStore.js.
const store = require("./newsThreads");

module.exports = {
  voteComment: (commentId, userId, direction) => store.voteComment(commentId, userId, direction),
  getUserVotes: (commentIds, userId) => store.getUserVotes(commentIds, userId),
};
