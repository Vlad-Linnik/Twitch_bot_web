// /<channel>/user/<username> - per-user analytics.
//
// Gating follows the "public showcase, private tooling" split:
//   the PAGE and its stats (message chart, clouds, heatmap, mentions) are public - they are the
//   channel's shop window, and they expose nothing a viewer could not have read in chat;
//   the LOG endpoints are requireLevel(2) - a moderator reading back an individual user's
//   messages is a moderation tool, not a stat.
//
// Every handler is thin, per this repo's convention: resolve channel -> resolve user -> hand off
// to a db/*Repo.js module -> render. All the memory discipline lives in the repos and in
// config/statsLimits.js, not here; a route never takes a caller's period/limit at face value.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const userStatsRepo = require("../db/userStatsRepo");
const wordStatsRepo = require("../db/wordStatsRepo");
const searchRepo = require("../db/searchRepo");
const userProfileService = require("../db/userProfileService");
const { computePermission } = require("../middleware/permissions");
const { statsReadLimiter, searchLimiter } = require("../middleware/rateLimiters");
const limits = require("../config/statsLimits");

const router = express.Router();

// middleware/permissions.js's requireLevel() renders the errors/403 HTML page on denial, which is
// right for a page and useless inside a fetch() - the browser would parse an HTML document as the
// JSON search result. So the JSON endpoints get their own gate with the same semantics (same
// computePermission, same fail-closed behaviour, same 401-vs-403 distinction) but a JSON body.
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

// Channel existence and user existence are checked independently of any permission gate - the
// same rule the settings/statistics routes follow (see CLAUDE.md, "Adding a new page").
async function resolveTarget(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  const identity = await userStatsRepo.findUserByName(req.params.username);
  if (!identity) {
    res.status(404).render("errors/404");
    return null;
  }
  return { channel, identity };
}

// --- Page -------------------------------------------------------------------------------

router.get("/:channel/user/:username", async (req, res, next) => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    const { channel, identity } = target;

    const period = limits.resolvePeriod(req.query.period);

    // Goes through the shared display service, NOT profileCacheRepo directly. Reading the cached
    // Twitch colour straight off the profile - which this route used to do - ignores the user's
    // own custom colour from /settings, so the same person rendered in one colour in the nav bar
    // and a different one here, on their own page. The service owns that policy now.
    // Fails soft: the header falls back to a monogram and an undecorated name.
    const profile = await userProfileService.getDisplayProfile(identity.userId);

    const [standing, activity, heatmap, mentions, clouds, permission] = await Promise.all([
      userStatsRepo.getLifetimeStanding(channel.channelLogin, identity.userId),
      // Two reads of the same index range on purpose: the chart needs period-shaped buckets
      // (getMessageVolume), the heatmap always needs the full day-bucketed window.
      userStatsRepo.getMessageVolume(channel.channelLogin, identity.userId, period),
      userStatsRepo.getDailyMessageCounts(channel.channelLogin, identity.userId),
      userStatsRepo.getMentionStats(channel.channelLogin, identity, period),
      wordStatsRepo.getUserClouds(channel.channelLogin, identity.userId, period),
      // This page is public, so no requireLevel() has run and req.permissionLevel is unset -
      // compute the tier explicitly just to decide whether to render the moderator panel.
      computePermission(req.user?.userId ?? null, channel.channelLogin),
    ]);

    res.render("userDashboard", {
      channel,
      identity,
      profile,
      period,
      periods: limits.PERIODS,
      standing,
      activity,
      heatmap,
      mentions,
      clouds,
      nicknames: userStatsRepo.nicknameHistory(identity),
      // Only decides whether the moderator panel is DRAWN. It is not the security boundary -
      // logs.json independently re-checks the tier on every request - but there is no point
      // rendering a panel whose every call could only 403.
      canModerate: permission <= 2,
      maxHeatmapDays: limits.MAX_HEATMAP_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

// --- Period switches (JSON) ---------------------------------------------------------------
// One endpoint, one component, so a period change re-fetches only what actually changed rather
// than re-rendering the page.

router.get("/:channel/user/:username/stats.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });
    const identity = await userStatsRepo.findUserByName(req.params.username);
    if (!identity) return res.status(404).json({ error: "unknown_user" });

    const period = limits.resolvePeriod(req.query.period);

    switch (req.query.component) {
      case "clouds":
        return res.json(await wordStatsRepo.getUserClouds(channel.channelLogin, identity.userId, period));
      case "mentions":
        return res.json(await userStatsRepo.getMentionStats(channel.channelLogin, identity, period));
      case "activity":
        return res.json(await userStatsRepo.getMessageVolume(channel.channelLogin, identity.userId, period));
      default:
        return res.status(400).json({ error: "unknown_component" });
    }
  } catch (err) {
    next(err);
  }
});

// --- Moderator-only log view ---------------------------------------------------------------

router.get(
  "/:channel/user/:username/logs.json",
  requireLevelJson(2),
  searchLimiter,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });
      const identity = await userStatsRepo.findUserByName(req.params.username);
      if (!identity) return res.status(404).json({ error: "unknown_user" });

      // Scoping to this one user is what makes the search cheap: the {channel, userId, timestamp}
      // index narrows the candidate set to one person's history before any text matching, which
      // also means fuzzy is almost always affordable here (unlike the channel-wide search).
      const result = await searchRepo.searchLogs(channel.channelLogin, {
        term: req.query.q,
        userIds: [identity.userId],
        period: req.query.period,
        fuzzy: req.query.fuzzy === "1",
        limit: req.query.limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
