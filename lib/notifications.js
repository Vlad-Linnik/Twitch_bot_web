// Rules behind the site's notifications (db/notificationsRepo.js stores them, routes/notifications.js
// serves them, public/js/notifications.js draws the bell). Pure, so the tests pin them without a
// database.
//
// The one kind there is today: somebody replied to your comment, in any section built on the shared
// discussion layer (db/threadStore.js + routes/discussionRoutes.js). The document is self-contained -
// who, where, a short excerpt and the link - so the bell never has to join back into a section's
// comment collection to draw a row, and a section added later needs no change here.

// Long enough to recognise the reply, short enough for a dropdown row. Code points, not UTF-16
// units: an emoji must not be cut in half.
const EXCERPT_MAX_CHARS = 140;
// Item titles come from the section's own document and are only a label here.
const TITLE_MAX_CHARS = 120;
// What the bell's dropdown shows; the full page shows more.
const DROPDOWN_LIMIT = 10;
const PAGE_LIMIT = 100;
// The badge stops counting here - "9+" says everything a larger number would.
const BADGE_MAX = 9;

function clip(text, max) {
  const chars = Array.from(String(text == null ? "" : text).replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}

const excerptOf = (body) => clip(body, EXCERPT_MAX_CHARS);

// The reply's permalink. `?comment=` makes the item page include the reply's root thread even when
// it sits past the first page of threads (revealRootCount); the hash scrolls to the reply itself.
function replyLink(threadBase, commentId) {
  const id = String(commentId);
  return `${threadBase}?comment=${encodeURIComponent(id)}#comment-${id}`;
}

// The notification a new reply produces, or null when there is nobody to tell:
//   - not a reply (no parent);
//   - a reply to your own comment - you know you wrote it;
//   - the parent was removed by a moderator - its author's thread is no longer visible to others,
//     and the notice would point at a conversation nobody else can see.
// `item` is the section's document (news post, media card); only its title is kept.
function buildReplyNotification({ parent, reply, section, channelLogin, item, threadBase }) {
  if (!parent || !reply) return null;
  if (parent.removed) return null;
  const recipient = String(parent.authorUserId || "");
  const actor = String(reply.authorUserId || "");
  if (!recipient || !actor || recipient === actor) return null;
  return {
    userId: recipient,
    type: "reply",
    actorUserId: actor,
    actorLogin: reply.authorLogin || "",
    actorDisplayName: reply.authorDisplayName || reply.authorLogin || "",
    section,
    channelLogin: String(channelLogin || "").toLowerCase(),
    itemId: String(item && item._id != null ? item._id : ""),
    itemTitle: clip(item && item.title, TITLE_MAX_CHARS),
    commentId: String(reply._id),
    parentCommentId: String(parent._id),
    link: replyLink(threadBase, reply._id),
    excerpt: excerptOf(reply.body),
    read: false,
    readAt: null,
    createdAt: reply.createdAt instanceof Date ? reply.createdAt : new Date(),
  };
}

// Mongo filters for marking read. Both carry the recipient's id: a notification id alone must
// never let one user mark another user's notifications.
function markReadFilter(userId, notificationId) {
  return { _id: notificationId, userId: String(userId) };
}

function markAllReadFilter(userId) {
  return { userId: String(userId), read: false };
}

function badgeText(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "";
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);
}

// How many ROOT threads the item page must render so that `commentId` is among them: the page
// paginates by root (routes/discussionRoutes.js), and a reply deep in an old thread would otherwise
// sit past the first page with nothing for the link's #hash to land on. Returns at least pageSize;
// an unknown id changes nothing.
function revealRootCount(tree, commentId, pageSize) {
  if (!commentId || !Array.isArray(tree)) return pageSize;
  const target = String(commentId);
  const contains = (node) => String(node.id ?? node._id) === target || (node.children || []).some(contains);
  const index = tree.findIndex(contains);
  return index < 0 ? pageSize : Math.max(pageSize, index + 1);
}

module.exports = {
  EXCERPT_MAX_CHARS,
  TITLE_MAX_CHARS,
  DROPDOWN_LIMIT,
  PAGE_LIMIT,
  BADGE_MAX,
  excerptOf,
  replyLink,
  buildReplyNotification,
  markReadFilter,
  markAllReadFilter,
  badgeText,
  revealRootCount,
};
