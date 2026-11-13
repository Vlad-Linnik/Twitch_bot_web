// The discussion under an item of a channel section - comments, votes and moderation - as one
// router factory, so news, movies and games run the same code over their own thread stores
// (db/threadStore.js) instead of three copies of it.
//
// Mounted per section, it serves:
//   GET  /:channel/<section>/:id/comments.json            more root threads / another sort
//   POST /:channel/<section>/:id/comments                 a comment or a reply (JSON or redirect)
//   POST /:channel/<section>/comments/:commentId/vote
//   POST /:channel/<section>/comments/:commentId/delete    levels 0-2
//   POST /:channel/<section>/comments/:commentId/restrict  levels 0-2, author strictly below
//   POST /:channel/<section>/comment-bans/:userId/unrestrict
// and hands the section's own item page loadCommentTree + threadLocals, so the first paint and
// every later fragment come from the same shaping.
//
// Restrictions (NewsCommentBans) are one list per CHANNEL, shared by every section: someone
// restricted on a channel does not get a fresh platform under another of its sections.
//
// Moderation journal: the site admin's actions go to AdminActionLogs like every other admin
// action; the owner's and moderators' go to the channel's SettingsChangeLog (category "comment"),
// the journal the owner can actually read.
const express = require("express");
const commentBansRepo = require("../db/newsCommentBansRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const emoteImages = require("../twitch/emoteImages");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { computePermission, canEditSectionAt } = require("../middleware/permissions");
const { loadChannelSection } = require("../middleware/channelSection");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const { sanitizeReturnTo } = require("../lib/returnTo");
const { canModerateDiscussion, canRestrictAuthor, threadUrls } = require("../lib/discussion");
const {
  MAX_DEPTH,
  MAX_BODY_LENGTH,
  DEFAULT_COMMENT_SORT,
  isValidCommentSort,
  sanitizeCommentBody,
  isCommentBodyValid,
  buildCommentTree,
} = require("../lib/commentValidation");
const { renderCommentBody, buildEmoteLookup } = require("../lib/commentEmotes");

// Root-level threads per page - pagination is on ROOTS, see loadCommentTree.
const COMMENTS_PAGE_SIZE = 20;

// A lively back-and-forth can easily produce more than a handful of replies in a few minutes -
// 15/5min (3/min sustained) still stops a spam bot from flooding a thread faster than a human
// could type. Per user across every section: one person, one pace.
const commentPostLimiterAllow = createSimpleLimiter({ windowMs: 5 * 60 * 1000, max: 15 });
// Voting is lower-stakes than posting.
const commentVoteLimiterAllow = createSimpleLimiter({ windowMs: 60 * 1000, max: 30 });

// A fetch with Accept: application/json gets JSON (public/js/comment-thread.js splices the result
// into the page); a plain no-JS form submit gets the classic redirect.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

// `?sort=` / a posted `sort` is user input - never trusted past isValidCommentSort.
function resolveCommentSort(value) {
  return isValidCommentSort(value) ? value : DEFAULT_COMMENT_SORT;
}

/**
 * @param {object} opts
 * @param {string} opts.section          channel section key ("news", "movies", ...)
 * @param {object} opts.store            a db/threadStore.js instance
 * @param {Function} opts.getItem        async (id) => item doc with channelLogin, or null
 * @param {string} opts.adminActionPrefix AdminActionLogs action prefix ("newsComment", "mediaComment")
 * @param {Function} [opts.isItemOpen]   (item) => whether new comments/votes are accepted
 */
function createDiscussionRoutes({ section, store, getItem, adminActionPrefix, isItemOpen = () => true }) {
  const router = express.Router();

  // Reads let an admin preview a switched-off section; writes that leave data behind do not.
  // Moderation does - an admin cleaning up in preview is fine.
  const readJson = loadChannelSection(section, { json: true });
  const write = loadChannelSection(section, { allowPreview: false });
  const writeJson = loadChannelSection(section, { json: true, allowPreview: false });
  const moderate = [loadChannelSection(section, { maxLevel: 2 }), requireModerationRight];

  // Moderation is levels 0-2 (lib/discussion.js), and for a moderator also the owner's per-section
  // right "discussions" (lib/moderatorSections.js). Resolved once per request and kept on req: the
  // tree, the thread locals and the gate all ask, and the answer decides which buttons are drawn,
  // so a moderator never sees one the server would refuse. Needs req.channel and req.permission
  // (loadChannelSection).
  async function resolveModeration(req) {
    if (req.canModerateDiscussion === undefined) {
      req.canModerateDiscussion =
        canModerateDiscussion(req.permission) &&
        (await canEditSectionAt(req.permission, req.channel.channelId, req.user?.userId, "discussions"));
    }
    return req.canModerateDiscussion;
  }

  async function requireModerationRight(req, res, next) {
    try {
      if (await resolveModeration(req)) return next();
      res.status(403).render("errors/403", { requiredLevel: 1 });
    } catch (err) {
      next(err);
    }
  }

  async function itemOnChannel(id, channel) {
    const item = await getItem(id);
    return item && item.channelLogin === channel.channelLogin ? item : null;
  }

  // One query for every comment on the item (capped in db/threadStore.js), then the
  // avatar/color/emote shaping. Returns the FULL nested tree - callers paginate by slicing the
  // ROOT array, because a reply must load with its root thread and that boundary is not known up
  // front.
  //
  // For a moderator each node also gets canRestrict - whether the server would accept restricting
  // its author - so the button is only drawn where it works. One permission lookup per distinct
  // author, and only when the viewer can moderate at all.
  async function loadCommentTree(item, channel, req, sortMode) {
    const [flatComments, emoteMap] = await Promise.all([
      store.listComments(item._id),
      emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map()),
    ]);

    const userVotes = req.user
      ? await store.getUserVotes(flatComments.map((c) => String(c._id)), req.user.userId)
      : new Map();
    const authorProfiles = await profileCacheRepo.getOrFetchProfiles(flatComments.map((c) => c.authorUserId));
    const emoteLookup = buildEmoteLookup(emoteMap);

    const authorLevels = new Map();
    if (await resolveModeration(req)) {
      const authorIds = [...new Set(flatComments.map((c) => String(c.authorUserId)))];
      const levels = await Promise.all(authorIds.map((id) => computePermission(id, channel.channelLogin)));
      authorIds.forEach((id, i) => authorLevels.set(id, levels[i]));
    }

    const shaped = flatComments.map((c) => {
      const profile = authorProfiles.get(String(c.authorUserId));
      const authorLevel = authorLevels.get(String(c.authorUserId));
      return {
        ...c,
        id: String(c._id),
        parentId: c.parentId ? String(c.parentId) : null,
        myVote: userVotes.get(String(c._id)) || 0,
        authorAvatarUrl: profile?.avatarUrl || null,
        authorChatColor: profile?.chatColor || null,
        renderedBody: renderCommentBody(c.body, emoteLookup),
        canRestrict: authorLevel === undefined ? false : canRestrictAuthor(req.permission, authorLevel),
      };
    });
    return buildCommentTree(shaped, sortMode);
  }

  // Locals partials/commentThread.ejs needs besides the nodes - one place, so the item page,
  // comments.json and the single-comment reply cannot drift apart. Every caller has run
  // resolveModeration first (loadCommentTree does it).
  function threadLocals(req, res, channel, item, commentSort) {
    return {
      channel,
      user: req.user,
      canModerate: Boolean(req.canModerateDiscussion),
      ...threadUrls(section, channel.channelLogin, String(item._id)),
      maxCommentDepth: MAX_DEPTH,
      maxCommentBodyLength: MAX_BODY_LENGTH,
      commentSort,
      csrf: req.user ? res.locals.csrfToken || "" : "",
    };
  }

  // What the item page passes to newsPost.ejs-style templates for the thread section.
  async function threadPageLocals(req, res, channel, item) {
    const commentSort = resolveCommentSort(req.query.sort);
    const canModerate = await resolveModeration(req);
    const [commentTree, restrictedUsers, isRestricted, emoteMap] = await Promise.all([
      loadCommentTree(item, channel, req, commentSort),
      canModerate ? commentBansRepo.listForChannel(channel.channelLogin) : Promise.resolve([]),
      req.user ? commentBansRepo.isBanned(channel.channelLogin, req.user.userId) : Promise.resolve(false),
      // A second call is a cache hit (twitch/emoteImages.js caches per channel) - the comment
      // box's autocomplete needs the same list the server rendered with.
      emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map()),
    ]);
    return {
      ...threadLocals(req, res, channel, item, commentSort),
      commentTree: commentTree.slice(0, COMMENTS_PAGE_SIZE),
      hasMoreComments: commentTree.length > COMMENTS_PAGE_SIZE,
      nextCommentOffset: COMMENTS_PAGE_SIZE,
      emoteList: [...emoteMap].filter(([, url]) => url).map(([name, url]) => ({ name, url })),
      isRestricted,
      restrictedUsers,
      commentError: typeof req.query.error === "string" ? req.query.error : null,
    };
  }

  async function logModeration(req, channel, { action, target, details }) {
    if (req.permission === 0) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: `${adminActionPrefix}.${action === "restrict" ? "restrictUser" : action === "unrestrict" ? "unrestrictUser" : action}`,
        target: `${channel.channelLogin}:${target}`,
        details,
      });
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

  const backTo = (req, channel, anchor) =>
    `${sanitizeReturnTo(req.body.returnTo) || `/${channel.channelLogin}/${section}`}#${anchor}`;

  router.get(`/:channel/${section}/:id/comments.json`, readJson, async (req, res, next) => {
    try {
      const item = await itemOnChannel(req.params.id, req.channel);
      if (!item) return res.status(404).json({ ok: false, error: "not_found" });
      const commentSort = resolveCommentSort(req.query.sort);
      const tree = await loadCommentTree(item, req.channel, req, commentSort);
      const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
      res.render(
        "partials/commentThread",
        { nodes: tree.slice(skip, skip + COMMENTS_PAGE_SIZE), ...threadLocals(req, res, req.channel, item, commentSort) },
        (err, html) => {
          if (err) return next(err);
          res.json({ ok: true, html, hasMore: skip + COMMENTS_PAGE_SIZE < tree.length });
        }
      );
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel/${section}/:id/comments`, requireLogin, verifyToken, write, async (req, res, next) => {
    try {
      const { channel } = req;
      const item = await itemOnChannel(req.params.id, channel);
      if (!item || !isItemOpen(item)) return res.status(404).render("errors/404");

      // The active sort rides through the no-JS redirect, so posting does not reset it.
      const commentSort = resolveCommentSort(req.body.sort);
      const { threadBase } = threadUrls(section, channel.channelLogin, String(item._id));
      const backUrl = `${threadBase}?sort=${commentSort}`;
      const fail = (status, code) =>
        wantsJson(req) ? res.status(status).json({ ok: false, error: code }) : res.redirect(`${backUrl}&error=${code}`);

      if (await commentBansRepo.isBanned(channel.channelLogin, req.user.userId)) return fail(403, "restricted");
      if (!commentPostLimiterAllow(req.user.userId)) return fail(429, "rate_limited");

      const body = sanitizeCommentBody(req.body.body);
      if (!isCommentBodyValid(body)) return fail(400, "invalid_body");

      let parentId = null;
      let depth = 0;
      if (req.body.parentId) {
        const parent = await store.getComment(req.body.parentId);
        // A tampered parentId must not attach a reply to another item's thread.
        if (!parent || store.itemIdOf(parent) !== String(item._id)) return fail(400, "invalid_parent");
        if (parent.depth + 1 > MAX_DEPTH) return fail(400, "too_deep");
        parentId = parent._id;
        depth = parent.depth + 1;
      }

      const created = await store.createComment({
        itemId: item._id,
        channelLogin: channel.channelLogin,
        parentId,
        depth,
        authorUserId: req.user.userId,
        authorLogin: req.user.login,
        authorDisplayName: req.user.displayName || req.user.login,
        body,
      });

      // No JS: back to the new comment's anchor (reliable for a reply and for "Newest"; for a new
      // root under "Top"/"Oldest" it may sit past the first page and the browser just stays put).
      if (!wantsJson(req)) return res.redirect(`${backUrl}#comment-${created._id}`);
      // The fragment carries the moderation menu like any other comment, so the right is needed
      // here too - nothing else on this path has asked yet.
      await resolveModeration(req);

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
        { nodes: [node], ...threadLocals(req, res, channel, item, commentSort) },
        (err, html) => {
          if (err) return next(err);
          res.json({ ok: true, html, commentId: node.id, parentId: node.parentId });
        }
      );
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel/${section}/comments/:commentId/vote`, requireLogin, verifyToken, writeJson, async (req, res, next) => {
    try {
      if (!commentVoteLimiterAllow(req.user.userId)) return res.status(429).json({ ok: false, error: "rate_limited" });
      const direction = parseInt(req.body.direction, 10);
      if (direction !== 1 && direction !== -1) return res.status(400).json({ ok: false, error: "invalid_direction" });

      const comment = await store.getComment(req.params.commentId);
      if (!comment || comment.channelLogin !== req.channel.channelLogin) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      const result = await store.voteComment(req.params.commentId, req.user.userId, direction);
      if (!result) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel/${section}/comments/:commentId/delete`, moderate, verifyToken, async (req, res, next) => {
    try {
      const { channel } = req;
      const comment = await store.getComment(req.params.commentId);
      if (comment && comment.channelLogin === channel.channelLogin) {
        const removed = await store.removeComment(comment._id, req.user.userId);
        if (removed) await logModeration(req, channel, { action: "delete", target: String(comment._id), details: comment.authorLogin });
      }
      res.redirect(backTo(req, channel, `comment-${req.params.commentId}`));
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel/${section}/comments/:commentId/restrict`, moderate, verifyToken, async (req, res, next) => {
    try {
      const { channel } = req;
      const comment = await store.getComment(req.params.commentId);
      if (comment && comment.channelLogin === channel.channelLogin) {
        // Strictly below the person restricting (lib/discussion.js); otherwise only deletion.
        const authorLevel = await computePermission(comment.authorUserId, channel.channelLogin);
        if (canRestrictAuthor(req.permission, authorLevel)) {
          await commentBansRepo.restrict(channel.channelLogin, comment.authorUserId, comment.authorLogin, req.user.userId);
          await logModeration(req, channel, { action: "restrict", target: String(comment.authorUserId), details: comment.authorLogin });
        }
      }
      res.redirect(backTo(req, channel, `comment-${req.params.commentId}`));
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel/${section}/comment-bans/:userId/unrestrict`, moderate, verifyToken, async (req, res, next) => {
    try {
      const { channel } = req;
      const bans = await commentBansRepo.listForChannel(channel.channelLogin);
      const ban = bans.find((b) => String(b.userId) === String(req.params.userId));
      if (ban) {
        await commentBansRepo.unrestrict(channel.channelLogin, req.params.userId);
        await logModeration(req, channel, { action: "unrestrict", target: String(req.params.userId), details: ban.userLogin });
      }
      res.redirect(backTo(req, channel, "restricted-users"));
    } catch (err) {
      next(err);
    }
  });

  return { router, loadCommentTree, threadLocals, threadPageLocals, resolveCommentSort };
}

module.exports = { createDiscussionRoutes, COMMENTS_PAGE_SIZE };
