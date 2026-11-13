// The discussion store for movie and game cards: comments, votes and hearts on MediaItems,
// through the same factory news uses (db/threadStore.js), under its own collections.
const { createThreadStore } = require("./threadStore");

module.exports = createThreadStore({
  items: "MediaItems",
  comments: "MediaComments",
  votes: "MediaCommentVotes",
  reactions: "MediaReactions",
  foreignKey: "itemId",
});
