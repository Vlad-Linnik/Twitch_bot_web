// Tier-0 admin panel: the bot-join request queue (counterpart of routes/requestBot.js),
// channel enable/disable, service-health tiles, the site-wide settings change log, and the
// admin action audit log. requireLevel(0) works unchanged on these non-channel routes:
// computePermission checks the ADMIN_USER_IDS allowlist before it ever looks at a channel.
const express = require("express");
const multer = require("multer");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const channelsRepo = require("../db/channelsRepo");
const botRequestsRepo = require("../db/botRequestsRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const ownerTokensRepo = require("../db/ownerTokensRepo");
const adminHealthRepo = require("../db/adminHealthRepo");
const botHeartbeatRepo = require("../db/botHeartbeatRepo");
const siteVisitsRepo = require("../db/siteVisitsRepo");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const gameCatalogRepo = require("../db/gameCatalogRepo");
const gameRunFlagsRepo = require("../db/gameRunFlagsRepo");
const { SOLO_GAMES } = require("../lib/gameReplay");
const gamesCatalog = require("../data/gamesCatalog");
const { SUPPORTED_LOCALES } = require("../config/i18n");
const profileCacheRepo = require("../db/profileCacheRepo");
const { describeChange } = require("../lib/settingsChangeDescribe");
const newsRepo = require("../db/newsRepo");
const newsReactionsRepo = require("../db/newsReactionsRepo");
const { saveNewsImage, deleteNewsImage } = require("../lib/newsImage");
const newsValidation = require("../lib/newsValidation");

const REJECT_REASON_MAX_LENGTH = 300;
// The bot writes a fresh heartbeat doc every 30s (TwitchBot's index.js) - anything older than a
// few missed writes means either the process is stuck badly enough to skip its own heartbeat
// write, or it's down entirely, so treat it the same as "offline" either way.
const BOT_HEARTBEAT_STALE_MS = 90 * 1000;

const router = express.Router();
const requireAdmin = requireLevel(0);

router.get("/admin", requireAdmin, async (req, res, next) => {
  try {
    const [pendingRequests, resolvedRequests, channels, tokenChannelIds, counts, botHeartbeat] = await Promise.all([
      botRequestsRepo.listPending(),
      botRequestsRepo.listResolved(),
      channelsRepo.listAll(),
      ownerTokensRepo.listChannelIds(),
      adminHealthRepo.getCollectionCounts(),
      botHeartbeatRepo.getBotHeartbeat(),
    ]);

    // Avatars for the pending queue - resolved-request rows just show the stored login.
    const profiles = await profileCacheRepo.getOrFetchProfiles(pendingRequests.map((r) => r.userId));

    const tokenIds = new Set(tokenChannelIds);
    const enabledChannels = channels.filter((c) => c.enabled);
    // An enabled channel with no stored owner refresh token gets no scheduled moderator
    // sync (twitch/moderatorSyncScheduler.js) until its owner logs in to the site once.
    const channelsWithoutToken = enabledChannels.filter((c) => !tokenIds.has(c.channelId));

    const botHeartbeatAgeMs = botHeartbeat ? Date.now() - new Date(botHeartbeat.updatedAt).getTime() : null;
    const botOnline = Boolean(botHeartbeat) && botHeartbeat.status === "ok" && botHeartbeatAgeMs < BOT_HEARTBEAT_STALE_MS;

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
        bot: botHeartbeat ? { ...botHeartbeat, online: botOnline, ageMs: botHeartbeatAgeMs } : null,
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

router.post("/admin/channels/:login/toggle-news", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const enable = req.body.newsEnabled === "1";
    const changed = await channelsRepo.setNewsEnabled(req.params.login, enable);
    if (changed) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: enable ? "channel.newsEnable" : "channel.newsDisable",
        target: req.params.login.toLowerCase(),
      });
    }
    res.redirect(`/admin?flash=${enable ? "newsEnabled" : "newsDisabled"}`);
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

// --- Flagged solo-game runs -------------------------------------------------
// The review queue for the anti-cheat (lib/gameReplay/). Nothing in that system
// ever blocks a player on suspicion: hard refusals are reserved for the
// provably impossible, and everything merely odd - a score the server's replay
// disagrees with, machine-regular input timing, a stale client - lands here for
// a human instead. That is deliberate, because the timing heuristics have a
// real false-positive rate (see lib/gameReplay/inputHeuristics.js).
const GAME_RUN_FLAGS_PER_PAGE = 25;

router.get("/admin/game-runs", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const status = ["open", "dismissed", "actioned"].includes(req.query.status)
      ? req.query.status
      : "open";
    const game = SOLO_GAMES.includes(req.query.game) ? req.query.game : null;
    const severity = ["low", "medium", "high"].includes(req.query.severity) ? req.query.severity : null;

    const { docs, total } = await gameRunFlagsRepo.listFlags({
      status,
      game,
      severity,
      skip: (page - 1) * GAME_RUN_FLAGS_PER_PAGE,
      limit: GAME_RUN_FLAGS_PER_PAGE,
    });

    // Same batch identity lookup the leaderboards use - one $in read plus one
    // Helix round-trip for whatever's missing.
    const profiles = await profileCacheRepo.getOrFetchProfiles(docs.map((d) => d.userId));
    const flags = docs.map((doc) => {
      const profile = profiles.get(String(doc.userId));
      return {
        ...doc,
        displayName: (profile && profile.displayName) || doc.userId,
        color: (profile && profile.chatColor) || null,
      };
    });

    res.render("adminGameRuns", {
      tab: "game-runs",
      flags,
      page,
      totalPages: Math.max(1, Math.ceil(total / GAME_RUN_FLAGS_PER_PAGE)),
      total,
      filters: { status, game, severity },
      games: SOLO_GAMES,
    });
  } catch (err) {
    next(err);
  }
});

// Both actions answer JSON to a fetch (so the admin keeps their scroll
// position) and fall back to a redirect for a plain form POST without JS -
// same split routes/settings.js uses for autosave.
function respondToFlagAction(req, res, payload) {
  if ((req.get("accept") || "").includes("application/json")) return res.json({ ok: true, ...payload });
  return res.redirect("/admin/game-runs");
}

router.post(
  "/admin/game-runs/:id/dismiss",
  settingsWriteLimiter,
  requireAdmin,
  verifyToken,
  async (req, res, next) => {
    try {
      const ok = await gameRunFlagsRepo.reviewFlag(req.params.id, {
        status: "dismissed",
        by: req.user.userId,
        note: typeof req.body.note === "string" ? req.body.note.slice(0, 500) : null,
      });
      if (!ok) return res.status(404).json({ ok: false, error: "notFound" });
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "gameRun.dismiss",
        target: req.params.id,
      });
      respondToFlagAction(req, res, { status: "dismissed" });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/admin/game-runs/:id/reset-score",
  settingsWriteLimiter,
  requireAdmin,
  verifyToken,
  async (req, res, next) => {
    try {
      const flag = await gameRunFlagsRepo.findById(req.params.id);
      if (!flag) return res.status(404).json({ ok: false, error: "notFound" });
      // gameScoresRepo.deleteUserScore refuses any key outside SOLO_GAMES, so
      // this can never reach a multiplayer Elo row.
      const deleted = await gameScoresRepo.deleteUserScore(flag.game, flag.userId);
      await gameRunFlagsRepo.reviewFlag(req.params.id, {
        status: "actioned",
        by: req.user.userId,
        note: typeof req.body.note === "string" ? req.body.note.slice(0, 500) : null,
      });
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "gameRun.resetScore",
        target: `${flag.game}:${flag.userId}`,
        details: { runId: flag.runId, deleted },
      });
      respondToFlagAction(req, res, { status: "actioned", deleted });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/admin/actions", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const log = await adminActionLogsRepo.listRecent({ page });
    res.render("adminActions", { tab: "actions", ...log });
  } catch (err) {
    next(err);
  }
});

// Tier-0 only, same as the rest of /admin - see ../CLAUDE.md's answer on why
// both the "hide from the public /games hub" (admin) and "group into
// categories" (moderator) controls live in this one tier-0 tab rather than
// being split across separate permission tiers: the on-site games are
// site-wide, not per-channel, so there's no natural per-channel moderator
// scope for either control - unlike settings.js's per-channel pages.
const CATEGORY_NAME_MAX_LENGTH = 60;

// Every category needs a name in every locale the site supports
// (config/i18n.js's SUPPORTED_LOCALES) so it reads correctly regardless of
// the visitor's language - see gameCatalogRepo.js's `names` map.
function parseCategoryNames(body) {
  const names = {};
  for (const locale of SUPPORTED_LOCALES) {
    const raw = body[`name_${locale}`];
    names[locale] = typeof raw === "string" ? raw.trim().slice(0, CATEGORY_NAME_MAX_LENGTH) : "";
  }
  return names;
}

function categoryNamesValid(names) {
  return SUPPORTED_LOCALES.every((locale) => names[locale]);
}

router.get("/admin/games", requireAdmin, async (req, res, next) => {
  try {
    const [settingsMap, categories] = await Promise.all([
      gameCatalogRepo.getSettingsMap(),
      gameCatalogRepo.listCategories(),
    ]);
    const games = gamesCatalog.map((g) => {
      const settings = settingsMap.get(g.id);
      return {
        id: g.id,
        nameKey: g.nameKey,
        hidden: Boolean(settings?.hidden),
        categoryId: settings?.categoryId ? String(settings.categoryId) : "",
      };
    });
    res.render("adminGames", { tab: "games", games, categories, flash: req.query.flash || null });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/games/:id/toggle-visibility", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const game = gamesCatalog.find((g) => g.id === req.params.id);
    if (!game) return res.redirect("/admin/games");
    const hidden = req.body.hidden === "1";
    await gameCatalogRepo.setHidden(game.id, hidden);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: hidden ? "game.hide" : "game.show",
      target: game.id,
    });
    res.redirect(`/admin/games?flash=${hidden ? "gameHidden" : "gameShown"}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/games/:id/category", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const game = gamesCatalog.find((g) => g.id === req.params.id);
    if (!game) return res.redirect("/admin/games");
    const categoryId = typeof req.body.categoryId === "string" ? req.body.categoryId.trim() : "";
    await gameCatalogRepo.setCategory(game.id, categoryId || null);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "game.setCategory",
      target: game.id,
      details: categoryId || null,
    });
    res.redirect("/admin/games?flash=gameCategorized");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/games/categories", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const names = parseCategoryNames(req.body);
    if (!categoryNamesValid(names)) return res.redirect("/admin/games?flash=categoryNameRequired");
    const category = await gameCatalogRepo.createCategory(names);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "gameCategory.create",
      target: String(category._id),
      details: names.en,
    });
    res.redirect("/admin/games?flash=categoryCreated");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/games/categories/:id/rename", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const names = parseCategoryNames(req.body);
    if (!categoryNamesValid(names)) return res.redirect("/admin/games?flash=categoryNameRequired");
    await gameCatalogRepo.renameCategory(req.params.id, names);
    await adminActionLogsRepo.logAction({ admin: req.user, action: "gameCategory.rename", target: req.params.id, details: names.en });
    res.redirect("/admin/games?flash=categoryRenamed");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/games/categories/:id/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    await gameCatalogRepo.deleteCategory(req.params.id);
    await adminActionLogsRepo.logAction({ admin: req.user, action: "gameCategory.delete", target: req.params.id });
    res.redirect("/admin/games?flash=categoryDeleted");
  } catch (err) {
    next(err);
  }
});

// --- News (site-admin-authored, per-channel feed at /:channel/news) -----------------------
// Tier-0 only, same as the rest of /admin - the site admin is the sole author (see plan doc:
// this mirrors /admin/games rather than settings.js's per-channel-owner pattern, since news
// authorship was deliberately kept out of channel owners' hands).
const NEWS_POSTS_PER_PAGE = 20;
const NEWS_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const newsImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: NEWS_IMAGE_MAX_BYTES },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/")),
});

// Wraps multer so a bad upload (oversized file, wrong field) becomes a form re-render with a
// friendly error instead of falling through to the generic 500 page - matches how every other
// mutation on this page reports failure via a rendered flash/error, never a raw error page.
function uploadNewsImage(req, res, next) {
  newsImageUpload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.newsImageUploadError = true;
      return next();
    }
    if (err) return next(err);
    next();
  });
}

router.get("/admin/news", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const channelFilter = typeof req.query.channel === "string" ? req.query.channel.trim().toLowerCase() : "";
    const [log, channels] = await Promise.all([
      newsRepo.listAll({ page, limit: NEWS_POSTS_PER_PAGE, channelLogin: channelFilter || null }),
      channelsRepo.listAll(),
    ]);
    res.render("adminNews", {
      tab: "news",
      posts: log.posts,
      totalPages: log.totalPages,
      page: log.page,
      channels,
      channelFilter,
      flash: req.query.flash || null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/news/new", requireAdmin, async (req, res, next) => {
  try {
    const channels = (await channelsRepo.listAll()).filter((c) => c.newsEnabled);
    res.render("adminNewsForm", { tab: "news", post: null, channels, error: null, isEdit: false, postId: null });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/news",
  settingsWriteLimiter,
  requireAdmin,
  uploadNewsImage,
  verifyToken,
  async (req, res, next) => {
    try {
      const channels = (await channelsRepo.listAll()).filter((c) => c.newsEnabled);
      const channel = channels.find((c) => c.channelLogin === (req.body.channelLogin || "").toLowerCase());
      const title = newsValidation.sanitizeTitle(req.body.title);
      const bodyFormat = req.body.bodyFormat;
      const bodyRaw = newsValidation.sanitizeBodyRaw(req.body.bodyRaw);

      if (!channel || !title || !newsValidation.isValidBodyFormat(bodyFormat) || !bodyRaw || !req.file || req.newsImageUploadError) {
        return res.status(400).render("adminNewsForm", {
          tab: "news",
          post: { channelLogin: req.body.channelLogin, title, bodyFormat, bodyRaw },
          channels,
          error: res.locals.t("admin.news.formError"),
          isEdit: false,
          postId: null,
        });
      }

      const imageResult = await saveNewsImage(req.file.buffer);
      const bodyHtml = newsValidation.renderBody(bodyFormat, bodyRaw);

      const post = await newsRepo.create({
        channelLogin: channel.channelLogin,
        title,
        bodyFormat,
        bodyRaw,
        bodyHtml,
        imageUrl: imageResult.url,
        imageWidth: imageResult.width,
        imageHeight: imageResult.height,
        authorUserId: req.user.userId,
        authorDisplayName: req.user.displayName || req.user.login,
      });

      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "news.create",
        target: `${channel.channelLogin}:${post._id}`,
        details: title,
      });

      res.redirect("/admin/news?flash=created");
    } catch (err) {
      next(err);
    }
  }
);

router.get("/admin/news/:id/edit", requireAdmin, async (req, res, next) => {
  try {
    const post = await newsRepo.getById(req.params.id);
    if (!post) return res.redirect("/admin/news");
    res.render("adminNewsForm", {
      tab: "news",
      post,
      channels: [{ channelLogin: post.channelLogin }],
      error: null,
      isEdit: true,
      postId: String(post._id),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/news/:id",
  settingsWriteLimiter,
  requireAdmin,
  uploadNewsImage,
  verifyToken,
  async (req, res, next) => {
    try {
      const existing = await newsRepo.getById(req.params.id);
      if (!existing) return res.redirect("/admin/news");

      const title = newsValidation.sanitizeTitle(req.body.title);
      const bodyFormat = req.body.bodyFormat;
      const bodyRaw = newsValidation.sanitizeBodyRaw(req.body.bodyRaw);

      if (!title || !newsValidation.isValidBodyFormat(bodyFormat) || !bodyRaw || req.newsImageUploadError) {
        return res.status(400).render("adminNewsForm", {
          tab: "news",
          post: { ...existing, title, bodyFormat, bodyRaw },
          channels: [{ channelLogin: existing.channelLogin }],
          error: res.locals.t("admin.news.formError"),
          isEdit: true,
          postId: String(existing._id),
        });
      }

      const bodyHtml = newsValidation.renderBody(bodyFormat, bodyRaw);
      let imagePatch = {};
      if (req.file) {
        const imageResult = await saveNewsImage(req.file.buffer);
        imagePatch = { imageUrl: imageResult.url, imageWidth: imageResult.width, imageHeight: imageResult.height };
      }

      await newsRepo.update(req.params.id, { title, bodyFormat, bodyRaw, bodyHtml, ...imagePatch });
      // Only unlink the OLD file after the new doc write succeeds - if the write had failed,
      // the stale file staying on disk is harmless; deleting it first and then failing the
      // write would leave the still-published post pointing at a missing image.
      if (imagePatch.imageUrl) await deleteNewsImage(existing.imageUrl);

      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "news.update",
        target: `${existing.channelLogin}:${existing._id}`,
        details: title,
      });

      res.redirect("/admin/news?flash=updated");
    } catch (err) {
      next(err);
    }
  }
);

router.post("/admin/news/:id/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const deleted = await newsRepo.deletePost(req.params.id);
    if (deleted) {
      await newsReactionsRepo.deleteAllForPost(String(deleted._id));
      await deleteNewsImage(deleted.imageUrl);
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "news.delete",
        target: `${deleted.channelLogin}:${deleted._id}`,
        details: deleted.title,
      });
    }
    res.redirect("/admin/news?flash=deleted");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
