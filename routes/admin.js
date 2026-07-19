// Tier-0 admin panel: the bot-join request queue (counterpart of routes/requestBot.js),
// channel enable/disable, service-health tiles, the site-wide settings change log, and the
// admin action audit log. requireLevel(0) works unchanged on these non-channel routes:
// computePermission checks the ADMIN_USER_IDS allowlist before it ever looks at a channel.
const express = require("express");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const channelsRepo = require("../db/channelsRepo");
const botRequestsRepo = require("../db/botRequestsRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const ownerTokensRepo = require("../db/ownerTokensRepo");
const adminHealthRepo = require("../db/adminHealthRepo");
const siteVisitsRepo = require("../db/siteVisitsRepo");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { describeChange } = require("../lib/settingsChangeDescribe");

const REJECT_REASON_MAX_LENGTH = 300;

const router = express.Router();
const requireAdmin = requireLevel(0);

router.get("/admin", requireAdmin, async (req, res, next) => {
  try {
    const [pendingRequests, resolvedRequests, channels, tokenChannelIds, counts] = await Promise.all([
      botRequestsRepo.listPending(),
      botRequestsRepo.listResolved(),
      channelsRepo.listAll(),
      ownerTokensRepo.listChannelIds(),
      adminHealthRepo.getCollectionCounts(),
    ]);

    // Avatars for the pending queue - resolved-request rows just show the stored login.
    const profiles = await profileCacheRepo.getOrFetchProfiles(pendingRequests.map((r) => r.userId));

    const tokenIds = new Set(tokenChannelIds);
    const enabledChannels = channels.filter((c) => c.enabled);
    // An enabled channel with no stored owner refresh token gets no scheduled moderator
    // sync (twitch/moderatorSyncScheduler.js) until its owner logs in to the site once.
    const channelsWithoutToken = enabledChannels.filter((c) => !tokenIds.has(c.channelId));

    res.render("admin", {
      tab: "overview",
      pendingRequests,
      resolvedRequests,
      profiles,
      channels,
      health: {
        ...counts,
        channelsEnabled: enabledChannels.length,
        channelsDisabled: channels.length - enabledChannels.length,
        channelsWithoutToken: channelsWithoutToken.map((c) => c.channelLogin),
      },
      flash: req.query.flash || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/requests/:id/approve", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    // resolve() only matches status:"pending" - claiming the request first means two admins
    // clicking simultaneously can't both act on it (the loser gets null and just redirects).
    const request = await botRequestsRepo.resolve(req.params.id, { status: "approved", resolvedBy: req.user });
    if (!request) return res.redirect("/admin");

    // The login may have changed since the request was submitted - Twitch identity is the
    // numeric id. Prefer the current login from the profile cache, fall back to the stored one.
    let channelLogin = request.login;
    try {
      const profile = await profileCacheRepo.getOrFetchProfile(request.userId);
      if (profile?.login) channelLogin = profile.login;
    } catch (err) {
      console.error("[admin] login refresh failed, using the login stored on the request:", err.message);
    }

    // Same effect as scripts/seedChannel.js: ownerId doubles as the broadcaster's channelId,
    // and first registration stamps consentedAt ($setOnInsert) - the approved request itself
    // is the owner-consent record behind it.
    await channelsRepo.upsertChannel({ channelLogin, channelId: request.userId, ownerId: request.userId });
    await adminActionLogsRepo.logAction({ admin: req.user, action: "request.approve", target: channelLogin });

    res.redirect("/admin?flash=approved");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/requests/:id/reject", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const rejectReason =
      typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, REJECT_REASON_MAX_LENGTH) : "";
    const request = await botRequestsRepo.resolve(req.params.id, {
      status: "rejected",
      resolvedBy: req.user,
      rejectReason,
    });
    if (!request) return res.redirect("/admin");

    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "request.reject",
      target: request.login,
      details: rejectReason || null,
    });

    res.redirect("/admin?flash=rejected");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/channels/:login/toggle", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const enable = req.body.enabled === "1";
    const changed = await channelsRepo.setEnabled(req.params.login, enable);
    if (changed) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: enable ? "channel.enable" : "channel.disable",
        target: req.params.login.toLowerCase(),
      });
    }
    res.redirect(`/admin?flash=${enable ? "enabled" : "disabled"}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/channels/:login/toggle-homepage", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const show = req.body.showOnHomepage === "1";
    const changed = await channelsRepo.setShowOnHomepage(req.params.login, show);
    if (changed) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: show ? "channel.homepageShow" : "channel.homepageHide",
        target: req.params.login.toLowerCase(),
      });
    }
    res.redirect(`/admin?flash=${show ? "homepageShown" : "homepageHidden"}`);
  } catch (err) {
    next(err);
  }
});

router.get("/admin/settings-log", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const log = await settingsChangeLogRepo.listRecentAll({ page });
    const entries = await describeAdminEntries(log.entries, res.locals.t);
    res.render("adminSettingsLog", { tab: "settings-log", ...log, entries, flash: req.query.flash || null });
  } catch (err) {
    next(err);
  }
});

// Site-wide equivalent of routes/settings.js's describeEntries - resolves
// "moderator-permission:<id>" targets and attaches a human summary to every entry.
async function describeAdminEntries(entries, t) {
  const moderatorIds = [
    ...new Set(
      entries
        .filter((e) => e.category === "settings" && e.target.startsWith("moderator-permission:"))
        .map((e) => e.target.slice("moderator-permission:".length))
    ),
  ];
  const moderatorNames = moderatorIds.length
    ? await profileCacheRepo
        .getOrFetchProfiles(moderatorIds)
        .then((profiles) => new Map([...profiles].map(([id, p]) => [id, p.displayName || id])))
        .catch(() => new Map())
    : new Map();

  return entries.map((e) => ({ ...e, description: describeChange(t, e, { moderatorNames }) }));
}

// Tier-0 only: wipes the entire cross-channel SettingsChangeLog (every channel's history, not
// just one). A confirmation checkbox on the admin page guards the click; this route itself just
// trusts the POST and records what happened in AdminActionLogs (the log of admin actions is a
// separate collection, so deleting SettingsChangeLog doesn't erase the fact that it was deleted).
router.post("/admin/settings-log/delete-all", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const deletedCount = await settingsChangeLogRepo.deleteAll();
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "settings-log.delete-all",
      target: "SettingsChangeLog",
      details: `${deletedCount} entries`,
    });
    res.redirect("/admin/settings-log?flash=deleted");
  } catch (err) {
    next(err);
  }
});

// Tier-0 only: removes a single SettingsChangeLog entry (as opposed to delete-all's full wipe).
// Redirects back to the same page the row was deleted from so the list doesn't jump to page 1.
router.post("/admin/settings-log/:id/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const entry = await settingsChangeLogRepo.deleteOne(req.params.id);
    if (entry) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "settings-log.delete-one",
        target: `${entry.channelLogin}:${entry.category}:${entry.target}`,
      });
    }
    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    res.redirect(`/admin/settings-log?page=${page}&flash=deleted`);
  } catch (err) {
    next(err);
  }
});

const VISITS_CHART_DAYS = 30;

// Maps a GameScores `game` key to the same display name already used on its own
// /games/* page - durak-multiplayer has no per-game page of its own (it's a mode
// within /games/durak), so it gets its own admin-only label instead.
const GAME_LABEL_KEYS = {
  "falling-blocks": "games.fallingBlocks.name",
  "pipe-dodger": "games.pipeDodger.name",
  "2048": "games.2048.name",
  "durak-multiplayer": "admin.gameDurakOnline",
};

// Named "/admin/visits", not "/admin/statistics" - routes/statistics.js already owns a
// "/:channel/statistics" route mounted earlier in routes/index.js, which would otherwise swallow
// this as channel="admin" (see that file's own wildcard-ordering warnings).
router.get("/admin/visits", requireAdmin, async (req, res, next) => {
  try {
    const [dailyVisits, gameCounts, playCounts] = await Promise.all([
      siteVisitsRepo.getDailyVisits(VISITS_CHART_DAYS),
      gameScoresRepo.getGameCounts(),
      gameSessionStatsRepo.getPlayCounts(),
    ]);
    const totalVisits = dailyVisits.reduce((sum, d) => sum + d.count, 0);
    const todayVisits = dailyVisits[dailyVisits.length - 1]?.count || 0;

    // Two independent counters, merged by game key: gameCounts is
    // distinct-player counts (GameScores has one doc per (game, userId)),
    // playCounts is total completed sessions/matches (GameSessionStats, one
    // $inc per finished run - see that repo's comment for why it can't just
    // be a field on GameScores). Union the keys rather than mapping one list,
    // since either collection can be momentarily ahead of the other.
    const playersByGame = new Map(gameCounts.map((g) => [g._id, g.count]));
    const sessionsByGame = new Map(playCounts.map((g) => [g.game, g.playCount]));
    const gameKeys = new Set([...playersByGame.keys(), ...sessionsByGame.keys()]);
    const maxSessions = Math.max(...sessionsByGame.values(), 1);

    const games = [...gameKeys]
      .map((key) => ({
        key,
        label: GAME_LABEL_KEYS[key] ? res.locals.t(GAME_LABEL_KEYS[key]) : key,
        players: playersByGame.get(key) || 0,
        sessions: sessionsByGame.get(key) || 0,
        pct: Math.round(((sessionsByGame.get(key) || 0) / maxSessions) * 100),
      }))
      .sort((a, b) => b.sessions - a.sessions);

    res.render("adminVisits", { tab: "statistics", dailyVisits, totalVisits, todayVisits, games });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/actions", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const log = await adminActionLogsRepo.listRecent({ page });
    res.render("adminActions", { tab: "actions", ...log });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
