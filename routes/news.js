// /:channel/news - the public per-channel news feed (off by default; admin-toggled per
// channel via /admin's Channels table, admin-authored via /admin/news). Visibility - unknown
// channel or the feed switched off both 404, except for a tier-0 admin previewing before the
// toggle is on - is middleware/channelSection.js's loadChannelSection, shared with the other
// channel sections.
//
// Discussion moderation (delete a comment, restrict or unrestrict a commenter) is open to levels
// 0-2: the site admin, the channel owner and the channel's moderators. A post is written by the
// admin, but the conversation under it happens in the channel's community, and the people who
// moderate that community's chat are the ones who know who to restrict. NewsCommentBans stays one
// list per channel, not per post.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const newsRepo = require("../db/newsRepo");
const newsReactionsRepo = require("../db/newsReactionsRepo");
const newsCommentsRepo = require("../db/newsCommentsRepo");
const newsCommentVotesRepo = require("../db/newsCommentVotesRepo");
const newsCommentBansRepo = require("../db/newsCommentBansRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const emoteImages = require("../twitch/emoteImages");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { computePermission, requireLevel } = require("../middleware/permissions");
const { loadChannelSection } = require("../middleware/channelSection");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const { sanitizeReturnTo } = require("../lib/returnTo");
const cursorPaging = require("../lib/cursorPaging");
const { buildChannelNav } = require("../lib/channelNav");
const { canModerateDiscussion, canRestrictAuthor, threadUrls } = require("../lib/discussion");
const {
  MAX_DEPTH,
  MAX_BODY_LENGTH,
  COMMENT_SORT_MODES,
  DEFAULT_COMMENT_SORT,
  isValidCommentSort,
  sanitizeCommentBody,
  isCommentBodyValid,
  buildCommentTree,
} = require("../lib/commentValidation");
const { renderCommentBody, buildEmoteLookup } = require("../lib/commentEmotes");

const router = express.Router();

// One feed portion. Posts render in full (body and image), so a portion stays small.
const POSTS_PER_PAGE = 10;
// Root-level (top-level) comment threads shown before a "Load more comments" click is needed -
// see loadCommentTree()'s comment for why pagination happens on ROOTS rather than the flat list.
const COMMENTS_PAGE_SIZE = 20;
const REACTION_TYPES = ["like", "superlike"];

// Same two-shapes-one-handler convention as routes/settings.js's autosave forms: a fetch with
// Accept: application/json gets JSON back (public/js/comment-thread.js's comment-post handler,
// which splices the reply straight into the thread with no reload), the plain no-JS form submit
// gets the classic redirect.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

// Reads (the feed, the permalink, comments.json) let an admin preview a switched-off feed.
// Writes that leave data behind (a heart, a comment, a vote) do not: nothing should accumulate on
// a section nobody else can see yet. Moderation does - an admin cleaning up in preview is fine.
const newsPage = loadChannelSection("news");
const newsJson = loadChannelSection("news", { json: true });
const newsWriteJson = loadChannelSection("news", { json: true, allowPreview: false });
const newsWrite = loadChannelSection("news", { allowPreview: false });
const newsModerate = loadChannelSection("news", { maxLevel: 2 });

// `?sort=`/a posted `sort` field is user-controlled input - never trust it past
// isValidCommentSort(), which is also what buildCommentTree() itself falls back on internally,
// so an invalid/missing value converges to the same DEFAULT_COMMENT_SORT either way. Takes the
// raw value directly (not `req`) so both a query string (GET) and a form field (POST, see the
// comment-post handler's hidden `sort` input - carrying the active sort through the redirect is
// what keeps posting a comment from silently resetting a visitor's "Newest"/"Oldest" choice back
// to the default) can resolve through the one function.
function resolveCommentSort(value) {
  return isValidCommentSort(value) ? value : DEFAULT_COMMENT_SORT;
}

// Shared by the permalink page (GET /:channel/news/:id) and the "load more comments" JSON
// endpoint below: one query for every comment on the post (small collection, capped - see
// db/threadStore.js), then the avatar/color/emote-image shaping both call sites need.
// Returns the FULL nested tree (buildCommentTree) - pagination is applied by the caller by
// slicing the ROOT array, not by limiting this query, because a reply must load together with
// whichever root thread it belongs to and there's no cheap way to know that boundary up front.
//
// For a moderator each node also gets canRestrict - whether the server would accept restricting
// its author (lib/discussion.js's canRestrictAuthor) - so the button is only drawn where it works.
// One permission lookup per distinct author, and only when the viewer can moderate at all.
async function loadCommentTree(post, channel, req, sortMode) {
  const [flatComments, emoteMap] = await Promise.all([
    newsCommentsRepo.listForPost(post._id),
    // Same channel-wide name -> image map the emote cloud resolves against (twitch/emoteImages.js) -
    // so a comment typed with an emote's name renders the actual emote, not its text signature.
    emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map()),
  ]);

  const userVotes = req.user
    ? await newsCommentVotesRepo.getUserVotes(flatComments.map((c) => String(c._id)), req.user.userId)
    : new Map();

  // Batched avatar + chat-color lookup for every commenter on the thread at once - same
  // getOrFetchProfiles() call the mod statistics page uses to color ~30 identities in one shot.
  const authorProfiles = await profileCacheRepo.getOrFetchProfiles(flatComments.map((c) => c.authorUserId));
  const emoteLookup = buildEmoteLookup(emoteMap);

  const authorLevels = new Map();
  if (canModerateDiscussion(req.permission)) {
    const authorIds = [...new Set(flatComments.map((c) => String(c.authorUserId)))];
    const levels = await Promise.all(authorIds.map((id) => computePermission(id, channel.channelLogin)));
    authorIds.forEach((id, i) => authorLevels.set(id, levels[i]));
  }

  const shapedComments = flatComments.map((c) => {
    const profile = authorProfiles.get(String(c.authorUserId));
    return {
      ...c,
      id: String(c._id),
      parentId: c.parentId ? String(c.parentId) : null,
      myVote: userVotes.get(String(c._id)) || 0,
      authorAvatarUrl: profile?.avatarUrl || null,
      authorChatColor: profile?.chatColor || null,
      renderedBody: renderCommentBody(c.body, emoteLookup),
      canRestrict: authorLevels.has(String(c.authorUserId))
        ? canRestrictAuthor(req.permission, authorLevels.get(String(c.authorUserId)))
        : false,
    };
  });

  return buildCommentTree(shapedComments, sortMode);
}

// The locals partials/commentThread.ejs needs besides the nodes themselves - one place, so the
// permalink page, comments.json and the single-comment JSON reply cannot drift apart.
function threadLocals(req, res, channel, post, commentSort) {
  return {
    channel,
    user: req.user,
    canModerate: canModerateDiscussion(req.permission),
    ...threadUrls("news", channel.channelLogin, String(post._id)),
    maxCommentDepth: MAX_DEPTH,
    maxCommentBodyLength: MAX_BODY_LENGTH,
    commentSort,
    csrf: req.user ? res.locals.csrfToken || "" : "",
  };
}

// Who moderated what. The site admin's actions go to AdminActionLogs, as every other admin
// action does; the owner's and moderators' go to the channel's own SettingsChangeLog, which is
// the journal the owner can actually read (/<channel>/settings/change-log).
async function logModeration(req, channel, { action, adminAction, target, details }) {
  if (req.permission === 0) {
    await adminActionLogsRepo.logAction({ admin: req.user, action: adminAction, target: `${channel.channelLogin}:${target}`, details });
    return;
  }
  await settingsChangeLogRepo.logChange({
    channelLogin: channel.channelLogin,
    user: req.user,
    category: "comment",
    action,
    target: details || target,
    before: null,
    after: null,
  });
}

// Low-stakes, frequent clicks - same reasoning/shape as durakStickerLimiter.
const reactLimiterAllow = createSimpleLimiter({ windowMs: 8 * 1000, max: 8 });
// A lively back-and-forth can easily produce more than a handful of replies in a few minutes -
// 15/5min (3/min sustained) still stops a spam bot from flooding a thread faster than a human
// could physically type, without throttling a real conversation.
const commentPostLimiterAllow = createSimpleLimiter({ windowMs: 5 * 60 * 1000, max: 15 });
// Same reasoning as reactLimiterAllow - voting is even lower-stakes than reacting.
const commentVoteLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 30 });

// The feed loads in portions by cursor (lib/cursorPaging.js), not by page number: a post
// published while someone is scrolling would otherwise shift every offset by one and repeat a
// card at the seam. The HTML page and list.json take the same `?cursor=`, so the page's plain
// "show more" link is a complete no-JS fallback and public/js/infinite-list.js only fetches the
// same portions in place. A stale `?page=N` link from before is simply ignored - page numbers do
// not exist in this model - and lands on the first portion.
//
// "Back" restore: list.json?through=<id> reloads everything from the top down to that post (and
// one portion past it), so the reader returns to the card they left from even if newer posts
// appeared above it. Capped (RESTORE_MAX) - past that the client keeps the ordinary first
// portion it already has.
const RESTORE_MAX = 240;

async function shapeFeedPosts(posts, req) {
  let reacted = new Set();
  if (req.user && posts.length > 0) {
    reacted = await newsReactionsRepo.getUserReactions(
      posts.map((p) => String(p._id)),
      req.user.userId
    );
  }
  return posts.map((p) => ({
    ...p,
    id: String(p._id),
    likedByViewer: reacted.has(`${p._id}:like`),
    superlikedByViewer: reacted.has(`${p._id}:superlike`),
  }));
}

router.get("/:channel/news", newsPage, async (req, res, next) => {
  try {
    const { channel, permission } = req;

    const parsed = cursorPaging.parseCursor(newsRepo.FEED_SORT, req.query.cursor);
    if (parsed.error) {
      return res.status(400).render("errors/400", { backHref: `/${channel.channelLogin}/news` });
    }

    const [{ posts, nextCursor }, broadcaster] = await Promise.all([
      newsRepo.listPortion(channel.channelLogin, { cursor: parsed.cursor, limit: POSTS_PER_PAGE }),
      // Same fail-soft avatar/chat-color lookup the statistics header uses.
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
    ]);

    res.render("news", {
      channel,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission, active: "news" }),
      posts: await shapeFeedPosts(posts, req),
      nextCursor,
      // Restoring a scroll position only makes sense for the feed read from the top; a
      // `?cursor=` page is the no-JS fallback, and JS readers never land on one.
      isFeedTop: !parsed.cursor,
      // Authorship stays with the site admin (routes/admin.js's /admin/news). The button only
      // shortens the way there; GET /:channel/news/new opens the same form.
      canCreate: permission === 0 && Boolean(channel.newsEnabled),
      newsDisabledPreview: res.locals.sectionPreview,
    });
  } catch (err) {
    next(err);
  }
});

// One portion of feed cards as HTML, rendered by the same partial as the first paint, plus the
// cursor of the next portion (null at the end). Declared before /:channel/news/:id, which would
// otherwise read "list.json" as a post id.
router.get("/:channel/news/list.json", newsJson, async (req, res, next) => {
  try {
    const { channel } = req;

    let portion;
    let restored = false;
    if (req.query.through !== undefined) {
      portion = await newsRepo.listThrough(channel.channelLogin, String(req.query.through), {
        max: RESTORE_MAX,
        limit: POSTS_PER_PAGE,
      });
      // Anchor deleted, moved to another channel, or deeper than RESTORE_MAX: the client keeps
      // the first portion it already rendered.
      if (!portion) return res.json({ ok: true, restored: false });
      restored = true;
    } else {
      const parsed = cursorPaging.parseCursor(newsRepo.FEED_SORT, req.query.cursor);
      if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
      portion = await newsRepo.listPortion(channel.channelLogin, { cursor: parsed.cursor, limit: POSTS_PER_PAGE });
    }

    res.render(
      "partials/newsCards",
      { posts: await shapeFeedPosts(portion.posts, req), channel },
      (err, html) => {
        if (err) return next(err);
        res.json({ ok: true, html, nextCursor: portion.nextCursor, restored });
      }
    );
  } catch (err) {
    next(err);
  }
});

// "Create news" from the feed itself. Same form and same POST handler as /admin/news/new - only
// the channel is preselected and the form returns here afterwards. Declared before
// /:channel/news/:id for the same reason as list.json.
router.get("/:channel/news/new", requireLevel(0), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    // The admin form only offers (and its POST only accepts) channels with the feed on.
    if (!channel || !channel.newsEnabled) return res.status(404).render("errors/404");
    const channels = (await channelsRepo.listAll()).filter((c) => c.newsEnabled);
    res.render("adminNewsForm", {
      tab: "news",
      post: { channelLogin: channel.channelLogin },
      channels,
      error: null,
      isEdit: false,
      postId: null,
      returnTo: `/${channel.channelLogin}/news`,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/:id/react", requireLogin, verifyToken, newsWriteJson, async (req, res, next) => {
  try {
    if (!reactLimiterAllow(req.user.userId)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const type = req.body.type;
    if (!REACTION_TYPES.includes(type)) return res.status(400).json({ ok: false, error: "invalid_type" });

    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== req.channel.channelLogin) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const result = await newsReactionsRepo.toggleReaction(req.params.id, req.user.userId, type);
    if (!result) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, liked: result.liked, count: result.count });
  } catch (err) {
    next(err);
  }
});

// --- Permalink page: one post + its full nested comment thread ----------------------------
// The feed (GET /:channel/news above) only shows reactions - a post's comments live on its own
// page, same as Reddit's own /r/x/comments/:id/ split, so a heavily-discussed post doesn't bloat
// the 10-posts-per-portion feed with potentially hundreds of nested replies.
router.get("/:channel/news/:id", newsPage, async (req, res, next) => {
  try {
    const { channel, permission } = req;
    const canModerate = canModerateDiscussion(permission);

    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) return res.status(404).render("errors/404");

    const commentSort = resolveCommentSort(req.query.sort);

    const [broadcaster, restrictedUsers, commentTree, emoteMap] = await Promise.all([
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      // Only fetched for the moderators' "restricted commenters" panel - a regular visitor never
      // needs this list, so skip the query entirely for them.
      canModerate ? newsCommentBansRepo.listForChannel(channel.channelLogin) : Promise.resolve([]),
      loadCommentTree(post, channel, req, commentSort),
      // Re-fetched here (on top of the one loadCommentTree() already did internally) so the
      // comment box's client-side autocomplete/preview (public/js/emoteMatch.js) has the same
      // name -> image list the server just used to render existing comments - twitch/emoteImages.js
      // caches per-channel with a TTL, so this second call is a cache hit, not a second Helix/7TV
      // round trip.
      emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map()),
    ]);

    let reacted = new Set();
    let isRestricted = false;
    if (req.user) {
      [reacted, isRestricted] = await Promise.all([
        newsReactionsRepo.getUserReactions([String(post._id)], req.user.userId),
        newsCommentBansRepo.isBanned(channel.channelLogin, req.user.userId),
      ]);
    }

    const shapedPost = {
      ...post,
      id: String(post._id),
      likedByViewer: reacted.has(`${post._id}:like`),
      superlikedByViewer: reacted.has(`${post._id}:superlike`),
    };

    res.render("newsPost", {
      ...threadLocals(req, res, channel, post, commentSort),
      broadcaster,
      channelNav: buildChannelNav(channel, { permission, active: "news" }),
      post: shapedPost,
      // Only the first page of ROOT threads renders server-side - public/js/comment-thread.js
      // fetches the rest (COMMENTS_PAGE_SIZE at a time) from GET .../comments.json on demand.
      commentTree: commentTree.slice(0, COMMENTS_PAGE_SIZE),
      hasMoreComments: commentTree.length > COMMENTS_PAGE_SIZE,
      nextCommentOffset: COMMENTS_PAGE_SIZE,
      // [{name, url}], only entries with a resolved image - inlined once for the comment box's
      // autocomplete/live-preview (public/js/emoteMatch.js + comment-thread.js).
      emoteList: [...emoteMap].filter(([, url]) => url).map(([name, url]) => ({ name, url })),
      commentSortModes: COMMENT_SORT_MODES,
      isRestricted,
      restrictedUsers,
      newsDisabledPreview: res.locals.sectionPreview,
      commentError: typeof req.query.error === "string" ? req.query.error : null,
    });
  } catch (err) {
    next(err);
  }
});

// "Load more comments" - fetches the next page of ROOT threads (see loadCommentTree/
// COMMENTS_PAGE_SIZE above) and renders them through the very same partial the initial page
// uses, so a loaded-in-later thread is byte-for-byte identical to one rendered on first paint.
// Public GET, same visibility rule as the permalink page itself (off + non-admin -> 404).
router.get("/:channel/news/:id/comments.json", newsJson, async (req, res, next) => {
  try {
    const { channel } = req;
    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    // Same sort the visitor had active on the permalink page - the "load more" button's own
    // dataset carries it through (views/newsPost.ejs / public/js/comment-thread.js), so paging
    // through a "Newest" or "Oldest" thread list keeps that ordering instead of silently
    // reverting to the score default partway through.
    const commentSort = resolveCommentSort(req.query.sort);
    const commentTree = await loadCommentTree(post, channel, req, commentSort);
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const page = commentTree.slice(skip, skip + COMMENTS_PAGE_SIZE);

    res.render(
      "partials/commentThread",
      { nodes: page, ...threadLocals(req, res, channel, post, commentSort) },
      (err, html) => {
        if (err) return next(err);
        res.json({ ok: true, html, hasMore: skip + COMMENTS_PAGE_SIZE < commentTree.length });
      }
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/:id/comments", requireLogin, verifyToken, newsWrite, async (req, res, next) => {
  try {
    const { channel } = req;
    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) return res.status(404).render("errors/404");

    // Carries the visitor's active sort (views/newsPost.ejs/partials/commentThread.ejs's hidden
    // `sort` field) through the no-JS redirect fallback, so posting a comment while sorted
    // "Newest"/"Oldest" doesn't silently snap back to the default.
    const commentSort = resolveCommentSort(req.body.sort);
    const backUrl = `/${channel.channelLogin}/news/${post._id}?sort=${commentSort}`;

    const fail = (status, code) => {
      if (wantsJson(req)) return res.status(status).json({ ok: false, error: code });
      return res.redirect(`${backUrl}&error=${code}`);
    };

    const banned = await newsCommentBansRepo.isBanned(channel.channelLogin, req.user.userId);
    if (banned) return fail(403, "restricted");

    if (!commentPostLimiterAllow(req.user.userId)) return fail(429, "rate_limited");

    const body = sanitizeCommentBody(req.body.body);
    if (!isCommentBodyValid(body)) return fail(400, "invalid_body");

    let parentId = null;
    let depth = 0;
    if (req.body.parentId) {
      const parent = await newsCommentsRepo.getById(req.body.parentId);
      // Guards against a tampered parentId pointing at a comment on a DIFFERENT post - a reply
      // must nest under a comment that actually belongs to this thread.
      if (!parent || newsCommentsRepo.postIdOf(parent) !== String(post._id)) {
        return fail(400, "invalid_parent");
      }
      if (parent.depth + 1 > MAX_DEPTH) return fail(400, "too_deep");
      parentId = parent._id;
      depth = parent.depth + 1;
    }

    const created = await newsCommentsRepo.create({
      postId: post._id,
      channelLogin: channel.channelLogin,
      parentId,
      depth,
      authorUserId: req.user.userId,
      authorLogin: req.user.login,
      authorDisplayName: req.user.displayName || req.user.login,
      body,
    });

    if (!wantsJson(req)) {
      // No-JS fallback: anchored at the new comment (views/partials/commentThread.ejs gives
      // every <li> a matching id="comment-<id>") so the reload lands the visitor back where they
      // were instead of at the top of the page - reliable for a reply (its parent, and therefore
      // its position, didn't move) and for "Newest" sort (a brand-new comment is always first);
      // best-effort for "Top"/"Oldest" root comments, which can legitimately land past the first
      // loaded page - the browser just doesn't scroll in that case.
      return res.redirect(`${backUrl}#comment-${created._id}`);
    }

    // JS path: render the ONE new comment through the exact same partial the rest of the thread
    // uses (see loadCommentTree() above for the batched equivalent), so
    // public/js/comment-thread.js can splice it straight into the live DOM with no reload at all -
    // avatar/color/emote-rendering shaped the same way, just for a single comment instead of the
    // whole flat list.
    const [authorProfile, emoteMap] = await Promise.all([
      profileCacheRepo.getOrFetchProfile(req.user.userId).catch(() => null),
      emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map()),
    ]);
    const node = {
      ...created,
      id: String(created._id),
      parentId: parentId ? String(parentId) : null,
      myVote: 0,
      authorAvatarUrl: authorProfile?.avatarUrl || null,
      authorChatColor: authorProfile?.chatColor || null,
      renderedBody: renderCommentBody(created.body, buildEmoteLookup(emoteMap)),
      // Your own comment: nobody restricts themselves.
      canRestrict: false,
      children: [],
    };

    res.render(
      "partials/commentThread",
      { nodes: [node], ...threadLocals(req, res, channel, post, commentSort) },
      (err, html) => {
        if (err) return next(err);
        res.json({ ok: true, html, commentId: node.id, parentId: node.parentId });
      }
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/comments/:commentId/vote", requireLogin, verifyToken, newsWriteJson, async (req, res, next) => {
  try {
    if (!commentVoteLimiterAllow(req.user.userId)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const direction = parseInt(req.body.direction, 10);
    if (direction !== 1 && direction !== -1) return res.status(400).json({ ok: false, error: "invalid_direction" });

    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (!comment || comment.channelLogin !== req.channel.channelLogin) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const result = await newsCommentVotesRepo.voteComment(req.params.commentId, req.user.userId, direction);
    if (!result) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// --- Moderation (levels 0-2): delete a comment, restrict/unrestrict a commenter -------------
// Colocated here rather than in routes/admin.js: these forms render inline on the permalink page
// (views/partials/commentThread.ejs), so the actions that mutate it live with it too.
//
// Each redirects back anchored at what it acted on - `returnTo` can never carry a fragment
// itself (browsers never send one to the server), so it is appended here.

router.post("/:channel/news/comments/:commentId/delete", newsModerate, verifyToken, async (req, res, next) => {
  try {
    const { channel } = req;
    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (comment && comment.channelLogin === channel.channelLogin) {
      const removed = await newsCommentsRepo.removeByModerator(comment._id, req.user.userId);
      if (removed) {
        await logModeration(req, channel, {
          action: "delete",
          adminAction: "newsComment.delete",
          target: String(comment._id),
          details: comment.authorLogin,
        });
      }
    }
    res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#comment-${req.params.commentId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/comments/:commentId/restrict", newsModerate, verifyToken, async (req, res, next) => {
  try {
    const { channel } = req;
    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (comment && comment.channelLogin === channel.channelLogin) {
      // Only someone strictly below the person restricting: a moderator cannot silence another
      // moderator, the owner or the admin, the owner cannot silence the admin. Their comments can
      // still be deleted one by one.
      const authorLevel = await computePermission(comment.authorUserId, channel.channelLogin);
      if (!canRestrictAuthor(req.permission, authorLevel)) {
        return res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#comment-${req.params.commentId}`);
      }
      await newsCommentBansRepo.restrict(channel.channelLogin, comment.authorUserId, comment.authorLogin, req.user.userId);
      await logModeration(req, channel, {
        action: "restrict",
        adminAction: "newsComment.restrictUser",
        target: String(comment.authorUserId),
        details: comment.authorLogin,
      });
    }
    res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#comment-${req.params.commentId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/comment-bans/:userId/unrestrict", newsModerate, verifyToken, async (req, res, next) => {
  try {
    const { channel } = req;
    const bans = await newsCommentBansRepo.listForChannel(channel.channelLogin);
    const ban = bans.find((b) => String(b.userId) === String(req.params.userId));
    if (ban) {
      await newsCommentBansRepo.unrestrict(channel.channelLogin, req.params.userId);
      await logModeration(req, channel, {
        action: "unrestrict",
        adminAction: "newsComment.unrestrictUser",
        target: String(req.params.userId),
        details: ban.userLogin,
      });
    }
    // Anchored at the restricted-commenters panel (views/newsPost.ejs's id="restricted-users").
    res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#restricted-users`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
