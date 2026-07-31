// /:channel/news - the public per-channel news feed (off by default; admin-toggled per
// channel via /admin's Channels table, admin-authored via /admin/news - see CLAUDE.md's plan).
// Mirrors routes/statistics.js's channel-scoped 404 pattern: unknown channel or a channel with
// the feature off both 404, except a tier-0 admin previewing before flipping the toggle on.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const newsRepo = require("../db/newsRepo");
const newsReactionsRepo = require("../db/newsReactionsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { computePermission } = require("../middleware/permissions");
const { createSimpleLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

const POSTS_PER_PAGE = 10;
const REACTION_TYPES = ["like", "superlike"];

// Low-stakes, frequent clicks - same reasoning/shape as durakStickerLimiter.
const reactLimiterAllow = createSimpleLimiter({ windowMs: 8 * 1000, max: 8 });

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

module.exports = router;
