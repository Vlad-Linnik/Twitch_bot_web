// /<channel> - the channel's public analytics dashboard, plus the moderator-only Universal Log
// Search.
//
// MOUNTING: this router owns a ONE-SEGMENT wildcard ("/:channel"), so it must be mounted LAST in
// routes/index.js. Ahead of the static pages it would swallow "/commands", "/about", "/games" and
// "/settings" as channel names.
//
// Same gating split as the user dashboard: the stats are public (they are the channel's shop
// window), the log search is requireLevelJson(2).
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const statsRepo = require("../db/statsRepo");
const wordStatsRepo = require("../db/wordStatsRepo");
const userStatsRepo = require("../db/userStatsRepo");
const searchRepo = require("../db/searchRepo");
const { computePermission } = require("../middleware/permissions");
const { statsReadLimiter, searchLimiter } = require("../middleware/rateLimiters");
const limits = require("../config/statsLimits");

const router = express.Router();

// Same rationale as routes/userDashboard.js: requireLevel() renders an HTML error page, which is
// useless inside a fetch(). Same tier semantics, JSON body.
function requireLevelJson(maxLevel) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.userId ?? null;
      const level = await computePermission(userId, req.params.channel);
      req.permissionLevel = level;
      if (level > maxLevel) {
        return res.status(userId ? 403 : 401).json({ error: userId ? "forbidden" : "unauthenticated" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// --- Page -------------------------------------------------------------------------------

router.get("/:channel", async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const period = limits.resolvePeriod(req.query.period, { max: limits.MAX_CLOUD_PERIOD });

    const [totals, leaderboard, wordCloud, emoteCloud, trackedEmoteCount, permission] = await Promise.all([
      statsRepo.getChannelTotals(channel.channelLogin),
      statsRepo.getLeaderboard(channel.channelLogin, limits.DEFAULT_LEADERBOARD),
      wordStatsRepo.getChannelWordCloud(channel.channelLogin, period),
      wordStatsRepo.getChannelEmoteCloud(channel.channelLogin, period, limits.DEFAULT_LEADERBOARD),
      wordStatsRepo.getTrackedEmoteCount(channel.channelLogin),
      computePermission(req.user?.userId ?? null, channel.channelLogin),
    ]);

    res.render("channelDashboard", {
      channel,
      period,
      periods: limits.PERIODS,
      totals,
      leaderboard,
      wordCloud,
      emoteCloud,
      trackedEmoteCount,
      canModerate: permission <= 2,
      maxCloudPeriod: limits.MAX_CLOUD_PERIOD,
    });
  } catch (err) {
    next(err);
  }
});

// --- Period switches (JSON) ---------------------------------------------------------------

router.get("/:channel/stats.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    // The channel-wide clouds aggregate across every chatter, so they get the tightest period cap
    // in the codebase - see config/statsLimits.js for the measurements behind it.
    const period = limits.resolvePeriod(req.query.period, { max: limits.MAX_CLOUD_PERIOD });

    switch (req.query.component) {
      case "wordcloud":
        return res.json(await wordStatsRepo.getChannelWordCloud(channel.channelLogin, period));
      case "emotes":
        return res.json(
          await wordStatsRepo.getChannelEmoteCloud(channel.channelLogin, period, limits.DEFAULT_LEADERBOARD)
        );
      default:
        return res.status(400).json({ error: "unknown_component" });
    }
  } catch (err) {
    next(err);
  }
});

// --- Universal log search (moderator-only) --------------------------------------------------

router.get("/:channel/search.json", requireLevelJson(2), searchLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    // "users" is a comma-separated list of LOGINS as typed by the moderator; the search itself
    // filters on userId, so resolve first. Naming a user here doesn't just filter the result -
    // it narrows the index range the query runs over, which is what makes fuzzy affordable. So a
    // multi-user search is CHEAPER than a channel-wide one, not more expensive.
    const typed = String(req.query.users || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const { users, unresolved } = await userStatsRepo.resolveUserIds(typed);

    const result = await searchRepo.searchLogs(channel.channelLogin, {
      term: req.query.q,
      userIds: users.map((u) => u.userId),
      period: req.query.period,
      fuzzy: req.query.fuzzy === "1",
      limit: req.query.limit,
    });

    // Report the names we could not resolve rather than silently returning fewer results - a
    // moderator who typos a username should be told, not left wondering why someone has no logs.
    res.json({ ...result, users, unresolved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
