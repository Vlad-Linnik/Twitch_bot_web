// Rules shared by every channel section that has a discussion thread (news now; movies and games
// next). Pure, so the tests can pin them without a database.

// Levels are middleware/permissions.js's: 0 site admin, 1 channel owner, 2 channel moderator,
// 3 everyone else. Deleting comments and restricting commenters is open to 0-2 in every section.
const MODERATE_MAX_LEVEL = 2;

function canModerateDiscussion(permission) {
  return Number.isInteger(permission) && permission <= MODERATE_MAX_LEVEL;
}

// Restricting a commenter needs a strictly higher rank than theirs: a moderator cannot silence
// another moderator, the owner or the admin, and nobody restricts themselves through their own
// level. Deleting one of their comments is still allowed - that is reviewable and reversible in a
// way a restriction on someone with moderation rights is not.
function canRestrictAuthor(moderatorLevel, authorLevel) {
  return canModerateDiscussion(moderatorLevel) && authorLevel > moderatorLevel;
}

// The two URL roots partials/commentThread.ejs and public/js/comment-thread.js build every
// request from, instead of a hardcoded "/news/":
//   threadBase  - this item's thread: POST {threadBase}/comments, GET {threadBase}/comments.json
//   actionsBase - the section: POST {actionsBase}/comments/:id/{vote,delete,restrict},
//                 POST {actionsBase}/comment-bans/:userId/unrestrict
function threadUrls(section, channelLogin, itemId) {
  const actionsBase = `/${channelLogin}/${section}`;
  return { actionsBase, threadBase: `${actionsBase}/${itemId}` };
}

module.exports = { MODERATE_MAX_LEVEL, canModerateDiscussion, canRestrictAuthor, threadUrls };
