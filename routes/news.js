// /:channel/news - the public per-channel news feed (off by default; admin-toggled per
// channel via /admin's Channels table, admin-authored via /admin/news - see CLAUDE.md's plan).
// Mirrors routes/statistics.js's channel-scoped 404 pattern: unknown channel or a channel with
// the feature off both 404, except a tier-0 admin previewing before flipping the toggle on.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const newsRepo = require("../db/newsRepo");
const newsReactionsRepo = require("../db/newsReactionsRepo");
const newsCommentsRepo = require("../db/newsCommentsRepo");
const newsCommentVotesRepo = require("../db/newsCommentVotesRepo");
const newsCommentBansRepo = require("../db/newsCommentBansRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const emoteImages = require("../twitch/emoteImages");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { computePermission, requireLevel } = require("../middleware/permissions");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const { sanitizeReturnTo } = require("../lib/returnTo");
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

const POSTS_PER_PAGE = 10;
// Root-level (top-level) comment threads shown before a "Load more comments" click is needed -
// see loadCommentTree()'s comment for why pagination happens on ROOTS rather than the flat list.
const COMMENTS_PAGE_SIZE = 20;
const REACTION_TYPES = ["like", "superlike"];

// Same two-shapes-one-handler convention as routes/settings.js's autosave forms: a fetch with
// Accept: application/json gets JSON back (public/js/news-comments.js's comment-post handler,
// which splices the reply straight into the thread with no reload), the plain no-JS form submit
// gets the classic redirect.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

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
// db/newsCommentsRepo.js), then the avatar/color/emote-image shaping both call sites need.
// Returns the FULL nested tree (buildCommentTree) - pagination is applied by the caller by
// slicing the ROOT array, not by limiting this query, because a reply must load together with
// whichever root thread it belongs to and there's no cheap way to know that boundary up front.
async function loadCommentTree(post, channel, req, isAdmin, sortMode) {
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
    };
  });

  return buildCommentTree(shapedComments, sortMode);
}

// Low-stakes, frequent clicks - same reasoning/shape as durakStickerLimiter.
const reactLimiterAllow = createSimpleLimiter({ windowMs: 8 * 1000, max: 8 });
// A lively back-and-forth can easily produce more than a handful of replies in a few minutes -
// 15/5min (3/min sustained) still stops a spam bot from flooding a thread faster than a human
// could physically type, without throttling a real conversation.
const commentPostLimiterAllow = createSimpleLimiter({ windowMs: 5 * 60 * 1000, max: 15 });
// Same reasoning as reactLimiterAllow - voting is even lower-stakes than reacting.
const commentVoteLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 30 });

router.get("/:channel/news", async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const permission = await computePermission(req.user?.userId ?? null, channel.channelLogin);
    if (!channel.newsEnabled && permission > 0) return res.status(404).render("errors/404");

    const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [{ posts, totalPages, page }, broadcaster] = await Promise.all([
      newsRepo.listByChannel(channel.channelLogin, { page: requestedPage, limit: POSTS_PER_PAGE }),
      // Same fail-soft avatar/chat-color lookup the statistics header uses.
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
    ]);

    let reacted = new Set();
    if (req.user) {
      reacted = await newsReactionsRepo.getUserReactions(
        posts.map((p) => String(p._id)),
        req.user.userId
      );
    }

    const shaped = posts.map((p) => ({
      ...p,
      id: String(p._id),
      likedByViewer: reacted.has(`${p._id}:like`),
      superlikedByViewer: reacted.has(`${p._id}:superlike`),
    }));

    res.render("news", {
      channel,
      broadcaster,
      posts: shaped,
      page,
      totalPages,
      newsDisabledPreview: !channel.newsEnabled, // true only when a tier-0 admin is previewing
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/:id/react", requireLogin, verifyToken, async (req, res, next) => {
  try {
    if (!reactLimiterAllow(req.user.userId)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel || !channel.newsEnabled) return res.status(404).json({ ok: false, error: "not_found" });

    const type = req.body.type;
    if (!REACTION_TYPES.includes(type)) return res.status(400).json({ ok: false, error: "invalid_type" });

    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) {
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
// the 10-posts-per-page feed with potentially hundreds of nested replies.
router.get("/:channel/news/:id", async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const permission = await computePermission(req.user?.userId ?? null, channel.channelLogin);
    const isAdmin = permission === 0;
    if (!channel.newsEnabled && !isAdmin) return res.status(404).render("errors/404");

    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) return res.status(404).render("errors/404");

    const commentSort = resolveCommentSort(req.query.sort);

    const [broadcaster, restrictedUsers, commentTree, emoteMap] = await Promise.all([
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      // Only fetched for the admin-only "restricted commenters" panel - a regular visitor never
      // needs this list, so skip the query entirely for them.
      isAdmin ? newsCommentBansRepo.listForChannel(channel.channelLogin) : Promise.resolve([]),
      loadCommentTree(post, channel, req, isAdmin, commentSort),
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
      channel,
      broadcaster,
      post: shapedPost,
      // Only the first page of ROOT threads renders server-side - public/js/news-comments.js
      // fetches the rest (COMMENTS_PAGE_SIZE at a time) from GET .../comments.json on demand.
      commentTree: commentTree.slice(0, COMMENTS_PAGE_SIZE),
      hasMoreComments: commentTree.length > COMMENTS_PAGE_SIZE,
      nextCommentOffset: COMMENTS_PAGE_SIZE,
      maxCommentDepth: MAX_DEPTH,
      maxCommentBodyLength: MAX_BODY_LENGTH,
      // [{name, url}], only entries with a resolved image - inlined once for the comment box's
      // autocomplete/live-preview (public/js/emoteMatch.js + news-comments.js).
      emoteList: [...emoteMap].filter(([, url]) => url).map(([name, url]) => ({ name, url })),
      commentSort,
      commentSortModes: COMMENT_SORT_MODES,
      isAdmin,
      isRestricted,
      restrictedUsers,
      newsDisabledPreview: !channel.newsEnabled,
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
router.get("/:channel/news/:id/comments.json", async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ ok: false, error: "not_found" });

    const permission = await computePermission(req.user?.userId ?? null, channel.channelLogin);
    const isAdmin = permission === 0;
    if (!channel.newsEnabled && !isAdmin) return res.status(404).json({ ok: false, error: "not_found" });

    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    // Same sort the visitor had active on the permalink page - the "load more" button's own
    // dataset carries it through (views/newsPost.ejs / public/js/news-comments.js), so paging
    // through a "Newest" or "Oldest" thread list keeps that ordering instead of silently
    // reverting to the score default partway through.
    const commentSort = resolveCommentSort(req.query.sort);
    const commentTree = await loadCommentTree(post, channel, req, isAdmin, commentSort);
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const page = commentTree.slice(skip, skip + COMMENTS_PAGE_SIZE);

    res.render(
      "partials/commentThread",
      {
        nodes: page,
        channel,
        post: { id: String(post._id) },
        user: req.user,
        isAdmin,
        maxCommentDepth: MAX_DEPTH,
        maxCommentBodyLength: MAX_BODY_LENGTH,
        commentSort,
        csrf: req.user ? res.locals.csrfToken : "",
      },
      (err, html) => {
        if (err) return next(err);
        res.json({ ok: true, html, hasMore: skip + COMMENTS_PAGE_SIZE < commentTree.length });
      }
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/:id/comments", requireLogin, verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel || !channel.newsEnabled) return res.status(404).render("errors/404");

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
      if (!parent || String(parent.postId) !== String(post._id)) {
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
    // public/js/news-comments.js can splice it straight into the live DOM with no reload at all -
    // avatar/color/emote-rendering shaped the same way, just for a single comment instead of the
    // whole flat list.
    const [permission, authorProfile, emoteMap] = await Promise.all([
      computePermission(req.user.userId, channel.channelLogin),
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
      children: [],
    };

    res.render(
      "partials/commentThread",
      {
        nodes: [node],
        channel,
        post: { id: String(post._id) },
        user: req.user,
        isAdmin: permission === 0,
        maxCommentDepth: MAX_DEPTH,
        maxCommentBodyLength: MAX_BODY_LENGTH,
        commentSort,
        csrf: res.locals.csrfToken || "",
      },
      (err, html) => {
        if (err) return next(err);
        res.json({ ok: true, html, commentId: node.id, parentId: node.parentId });
      }
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/comments/:commentId/vote", requireLogin, verifyToken, async (req, res, next) => {
  try {
    if (!commentVoteLimiterAllow(req.user.userId)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel || !channel.newsEnabled) return res.status(404).json({ ok: false, error: "not_found" });

    const direction = parseInt(req.body.direction, 10);
    if (direction !== 1 && direction !== -1) return res.status(400).json({ ok: false, error: "invalid_direction" });

    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (!comment || comment.channelLogin !== channel.channelLogin) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const result = await newsCommentVotesRepo.voteComment(req.params.commentId, req.user.userId, direction);
    if (!result) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// --- Admin moderation (tier-0 only): delete a comment, restrict/unrestrict a commenter ------
// Deliberately colocated here rather than routes/admin.js - these forms render inline on THIS
// page (views/partials/commentThread.ejs), so the actions that mutate it live with it too,
// unlike news POST authoring (routes/admin.js), which has its own separate admin UI.

router.post("/:channel/news/comments/:commentId/delete", requireLevel(0), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (comment && comment.channelLogin === channel.channelLogin) {
      await newsCommentsRepo.removeByAdmin(comment._id, req.user.userId);
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "newsComment.delete",
        target: `${channel.channelLogin}:${comment._id}`,
      });
    }

    // Anchored at the comment this action was taken on (views/partials/commentThread.ejs's
    // id="comment-<id>") rather than reloading to the top of the page - `returnTo` is never able
    // to carry a fragment itself (browsers never send one to the server), so it has to be
    // appended here regardless of what page returnTo points at.
    res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#comment-${req.params.commentId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/news/comments/:commentId/restrict", requireLevel(0), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const comment = await newsCommentsRepo.getById(req.params.commentId);
    if (comment && comment.channelLogin === channel.channelLogin) {
      await newsCommentBansRepo.restrict(
        channel.channelLogin,
        comment.authorUserId,
        comment.authorLogin,
        req.user.userId
      );
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "newsComment.restrictUser",
        target: `${channel.channelLogin}:${comment.authorUserId}`,
        details: comment.authorDisplayName,
      });
    }

    // Same anchor reasoning as the delete route above - lands back on the comment that was acted
    // on instead of the top of the page.
    res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#comment-${req.params.commentId}`);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/news/comment-bans/:userId/unrestrict",
  requireLevel(0),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      await newsCommentBansRepo.unrestrict(channel.channelLogin, req.params.userId);
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "newsComment.unrestrictUser",
        target: `${channel.channelLogin}:${req.params.userId}`,
      });

      // Anchored at the restricted-commenters panel (views/newsPost.ejs's id="restricted-users")
      // rather than the top of the page - same reasoning as the delete/restrict routes above.
      res.redirect(`${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/news`}#restricted-users`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
