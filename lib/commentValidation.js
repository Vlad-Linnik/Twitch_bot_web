// Pure/testable helpers behind the news-comments feature (routes/news.js) - same "extract for
// npm test" convention as lib/newsValidation.js/lib/settingsValidation.js.
const MAX_BODY_LENGTH = 5000;

// Reddit visually caps nesting too (deep threads get unreadably narrow on mobile past a point) -
// this caps it structurally instead: a comment at MAX_DEPTH has no "Reply" affordance rendered,
// so a reply can never be created past this depth in the first place.
const MAX_DEPTH = 8;

// Rejects (rather than coerces) anything that isn't already a string - a stray array/object in
// the POST body (e.g. `body[]=x&body[]=y`, or a raw JSON object with an operator-shaped key) must
// never reach the insertOne() in db/newsCommentsRepo.js as anything other than plain text. Coercing
// via .toString() would still have been injection-safe (the mongodb driver never interpolates
// strings into queries), but typing it strictly here is the cheaper guarantee to reason about than
// re-deriving "is .toString() always safe" every time this function is touched.
function sanitizeCommentBody(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_BODY_LENGTH);
}

function isCommentBodyValid(body) {
  return typeof body === "string" && body.length > 0 && body.length <= MAX_BODY_LENGTH;
}

// The three orderings the permalink page's sort control (views/newsPost.ejs) offers. "score" is
// the default/original behavior; "new"/"old" are pure createdAt sorts.
const COMMENT_SORT_MODES = ["score", "new", "old"];
const DEFAULT_COMMENT_SORT = "score";

function isValidCommentSort(value) {
  return COMMENT_SORT_MODES.includes(value);
}

function compareComments(sortMode) {
  if (sortMode === "new") return (a, b) => b.createdAt - a.createdAt;
  if (sortMode === "old") return (a, b) => a.createdAt - b.createdAt;
  // "score" (and any invalid/missing value, so a bad ?sort= falls back here rather than throwing) -
  // ties broken newest-first, so among equally-rated comments the most recent conversation
  // surfaces first rather than the oldest one permanently squatting on top.
  return (a, b) => b.score - a.score || b.createdAt - a.createdAt;
}

// Flat NewsComments docs -> a nested tree, sorted per `sortMode` (see compareComments) at every
// level - Reddit applies its sort control the same way, not just to the top level. A comment
// whose parentId isn't in this batch (shouldn't happen under the soft-delete-only design - see
// db/newsCommentsRepo.js - but cheap to guard) falls back to rendering as a top-level comment
// instead of silently vanishing.
function buildCommentTree(flatComments, sortMode) {
  const compare = compareComments(sortMode);
  const byId = new Map(flatComments.map((c) => [String(c._id), { ...c, children: [] }]));
  const roots = [];

  for (const node of byId.values()) {
    const parentKey = node.parentId ? String(node.parentId) : null;
    if (parentKey && byId.has(parentKey)) {
      byId.get(parentKey).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (nodes, depth) => {
    nodes.sort(compare);
    for (const node of nodes) {
      node.depth = depth;
      sortRec(node.children, depth + 1);
    }
  };
  sortRec(roots, 0);

  return roots;
}

module.exports = {
  MAX_BODY_LENGTH,
  MAX_DEPTH,
  COMMENT_SORT_MODES,
  DEFAULT_COMMENT_SORT,
  isValidCommentSort,
  sanitizeCommentBody,
  isCommentBodyValid,
  buildCommentTree,
};
