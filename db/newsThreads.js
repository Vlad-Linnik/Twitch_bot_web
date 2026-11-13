// The news section's discussion store: comments, votes and hearts on NewsPosts, through the
// shared factory in db/threadStore.js. Collection and field names are the ones news has always
// used (`postId`), so nothing stored changes. routes/news.js hands it to the shared discussion
// routes (routes/discussionRoutes.js); db/newsReactionsRepo.js wraps its hearts for the feed.
const { createThreadStore } = require("./threadStore");

module.exports = createThreadStore({
  items: "NewsPosts",
  comments: "NewsComments",
  votes: "NewsCommentVotes",
  reactions: "NewsReactions",
  foreignKey: "postId",
});
