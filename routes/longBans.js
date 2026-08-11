// /<channel>/settings/long-bans - view + create + cancel long-bans (bans/timeouts that outlast
// Twitch's native 2-week timeout cap). This app has no Twitch moderation-action credentials of
// its own (see ../CLAUDE.md's "Long-bans: written by both repos, executed only by the bot"), so
// creating/cancelling here only ever writes a 'pending'/'cancelRequested' record for
// TwitchBot/twitch/longBanScheduler.js (polling every ~30s) to actually apply against Twitch.
//
// Fully gated at tier <= 2, same as routes/customCommands.js - these are writes to bot behavior,
// not statistics. Mounted alongside customCommands/counters in routes/index.js (before
// channelRedirect, whose bare "/:channel" would otherwise swallow every static page).
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const longBansRepo = require("../db/longBansRepo");
const unbanRequestsRepo = require("../db/unbanRequestsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSettingsEditAccess } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const { parseLongBanRequest, MAX_UNBAN_YEAR, MAX_REASON_LENGTH } = require("../lib/longBanValidation");
const { getUsersByLogin } = require("../twitch/helixUsers");

const router = express.Router();
const HISTORY_PER_PAGE = 25;

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

router.get("/:channel/settings/long-bans", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const historyPage = Math.max(1, parseInt(req.query.historyPage, 10) || 1);
    const [longBans, history, scheduledAmnesty] = await Promise.all([
      longBansRepo.listActiveForChannel(channel.channelId),
      longBansRepo.listHistoryForChannel(channel.channelId, {
        page: historyPage,
        limit: HISTORY_PER_PAGE,
      }),
      unbanRequestsRepo.listScheduledAmnestyForChannel(channel.channelId),
    ]);
    res.render("longBans", {
      channel,
      longBans,
      history: history.entries,
      historyPage: history.page,
      historyTotalPages: history.totalPages,
      scheduledAmnesty,
      maxUnbanYear: MAX_UNBAN_YEAR,
      maxReasonLength: MAX_REASON_LENGTH,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/settings/long-bans",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/settings/long-bans`;

      // Anchored at the existing-bans list (views/longBans.ejs's id="existing-bans") rather than
      // the top of the page - the cancel button lives below the entire Create section, so an
      // un-anchored reload would jump the mod away from the entry they were just looking at.
      if (req.body.action === "cancel") {
        const doc = await longBansRepo.findById(req.body.id);
        if (!doc || String(doc.channelId) !== String(channel.channelId)) {
          return res.redirect(`${back}?error=not_found#existing-bans`);
        }
        const updated = await longBansRepo.requestCancel(doc._id);
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "long_ban",
          action: "cancel", target: doc.userLogin, before: doc, after: updated,
        });
        // 'pending' -> 'cancelled' is immediate; 'active' -> 'cancelRequested' is finished by
        // TwitchBot/twitch/longBanScheduler.js's next ~30s poll.
        return res.redirect(`${back}?saved=cancelled#existing-bans`);
      }

      // Same rules the chat command enforces - see lib/longBanValidation.js for why that matters.
      const parsed = parseLongBanRequest({
        userLogin: req.body.userLogin,
        mode: req.body.mode,
        reason: req.body.reason,
        duration: req.body.duration,
      });
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

      const existing = await longBansRepo.findOccupyingByLogin(channel.channelId, parsed.userLogin);
      if (existing) return res.redirect(`${back}?error=already_active`);

      // Resolved here (not left to the bot) so the mod gets immediate "user not found" feedback
      // instead of waiting for the next poll to discover it - this app already has its own
      // independent Helix credentials for a read-only login->id lookup (see ../CLAUDE.md).
      const users = await getUsersByLogin([parsed.userLogin]);
      if (!users.length) return res.redirect(`${back}?error=user_not_found`);
      const targetUser = users[0];

      const doc = {
        channelId: String(channel.channelId),
        channelLogin: channel.channelLogin,
        userId: targetUser.id,
        userLogin: targetUser.login,
        mode: parsed.mode,
        reason: parsed.reason,
        createdBySource: "web",
        createdByLogin: req.user.login,
        createdByDisplayName: req.user.displayName,
        createdAt: new Date(),
        unbanAt: parsed.unbanAt,
        // The bot recomputes this to the correctly-clamped first segment when it applies the
        // pending doc (TwitchBot/twitch/longBanScheduler.js's processPending) - this initial value
        // just needs to be non-null so the doc shape matches an actively-applied one.
        nextRenewalAt: parsed.unbanAt,
        status: "pending",
      };
      try {
        await longBansRepo.create(doc);
      } catch (err) {
        if (err.code === "DUPLICATE_OCCUPYING") {
          return res.redirect(`${back}?error=already_active`);
        }
        throw err;
      }
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin, user: req.user, category: "long_ban",
        action: "create", target: targetUser.login, before: null,
        after: { mode: parsed.mode, unbanAt: parsed.unbanAt, reason: parsed.reason },
      });
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
