// The news section's discussion store: comments, votes and hearts on NewsPosts, through the
// shared factory in db/threadStore.js. Collection and field names are the ones news has always
// used (`postId`), so nothing stored changes. db/newsCommentsRepo.js, db/newsCommentVotesRepo.js
// and db/newsReactionsRepo.js are thin wrappers over this one instance.
const { createThreadStore } = require("./threadStore");

module.exports = createThreadStore({
  items: "NewsPosts",
  comments: "NewsComments",
  votes: "NewsCommentVotes",
  reactions: "NewsReactions",
  foreignKey: "postId",
});
