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
const profileCacheRepo = require("../db/profileCacheRepo");

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

router.get("/admin/settings-log", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const log = await settingsChangeLogRepo.listRecentAll({ page });
    res.render("adminSettingsLog", { tab: "settings-log", ...log });
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
