// /:channel/news - the public per-channel news feed (off by default; admin-toggled per
// channel via /admin's Channels table, admin-authored via /admin/news). Visibility - unknown
// channel or the feed switched off both 404, except for a tier-0 admin previewing before the
// toggle is on - is middleware/channelSection.js's loadChannelSection, shared with the other
// channel sections.
//
// The discussion under a post (comments, votes, moderation by levels 0-2) is
// routes/discussionRoutes.js, shared with the other channel sections. A post is written by the
// admin, but the conversation under it happens in the channel's community, and the people who
// moderate that community's chat are the ones who know who to restrict.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const newsRepo = require("../db/newsRepo");
const newsReactionsRepo = require("../db/newsReactionsRepo");
const newsThreads = require("../db/newsThreads");
const profileCacheRepo = require("../db/profileCacheRepo");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { requireLevel } = require("../middleware/permissions");
const { loadChannelSection } = require("../middleware/channelSection");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const cursorPaging = require("../lib/cursorPaging");
const { buildChannelNav } = require("../lib/channelNav");
const { COMMENT_SORT_MODES } = require("../lib/commentValidation");
const { createDiscussionRoutes } = require("./discussionRoutes");

const router = express.Router();

// One feed portion. Posts render in full (body and image), so a portion stays small.
const POSTS_PER_PAGE = 10;
const REACTION_TYPES = ["like", "superlike"];

// Reads (the feed, the permalink) let an admin preview a switched-off feed. A heart is a write
// that leaves data behind, and nothing should accumulate on a section nobody else can see yet.
const newsPage = loadChannelSection("news");
const newsJson = loadChannelSection("news", { json: true });
const newsWriteJson = loadChannelSection("news", { json: true, allowPreview: false });

// Comments, votes and moderation under a post - shared with the other channel sections.
const discussion = createDiscussionRoutes({
  section: "news",
  store: newsThreads,
  getItem: (id) => newsRepo.getById(id),
  adminActionPrefix: "newsComment",
});

// Low-stakes, frequent clicks - same reasoning/shape as durakStickerLimiter.
const reactLimiterAllow = createSimpleLimiter({ windowMs: 8 * 1000, max: 8 });

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
// The feed only shows reactions - a post's comments live on its own page, so a heavily-discussed
// post doesn't bloat the 10-posts-per-portion feed with hundreds of nested replies.
router.get("/:channel/news/:id", newsPage, async (req, res, next) => {
  try {
    const { channel, permission } = req;
    const post = await newsRepo.getById(req.params.id);
    if (!post || post.channelLogin !== channel.channelLogin) return res.status(404).render("errors/404");

    const [broadcaster, thread, reacted] = await Promise.all([
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      discussion.threadPageLocals(req, res, channel, post),
      req.user ? newsReactionsRepo.getUserReactions([String(post._id)], req.user.userId) : Promise.resolve(new Set()),
    ]);

    res.render("newsPost", {
      ...thread,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission, active: "news" }),
      post: {
        ...post,
        id: String(post._id),
        likedByViewer: reacted.has(`${post._id}:like`),
        superlikedByViewer: reacted.has(`${post._id}:superlike`),
      },
      commentSortModes: COMMENT_SORT_MODES,
      newsDisabledPreview: res.locals.sectionPreview,
    });
  } catch (err) {
    next(err);
  }
});

// Declared after the static /news/list.json and /news/new above, and after the permalink: its
// paths are all three or four segments deep, so none of them can be read as a post id.
router.use(discussion.router);

module.exports = router;
