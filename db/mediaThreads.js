// The discussion store for movie and game cards: comments and comment votes on MediaItems, through
// the same factory news uses (db/threadStore.js), under its own collections. No hearts: a card's
// viewers rate it 1-10 (db/mediaRatingsRepo.js) instead, and the news-style like/superlike would
// read as a second score next to it.
const { createThreadStore } = require("./threadStore");

module.exports = createThreadStore({
  items: "MediaItems",
  comments: "MediaComments",
  votes: "MediaCommentVotes",
  foreignKey: "itemId",
});
