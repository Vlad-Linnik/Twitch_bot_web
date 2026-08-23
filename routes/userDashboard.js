// /<channel>/user/<username> - per-user analytics.
//
// Login-required: the PAGE and its stats (message chart, clouds, heatmap, mentions) need a
// logged-in visitor (any tier), while the LOG endpoints stay requireLevel(2) - a moderator
// reading back an individual user's messages is a moderation tool, not a stat.
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
const userPreferencesRepo = require("../db/userPreferencesRepo");
const pageThemesRepo = require("../db/pageThemesRepo");
const { resolveTheme } = require("../lib/pageThemeValidation");
const { buildTrophies } = require("../lib/pageThemeHero");
const { withEmoteImages } = require("../twitch/emoteImages");
const { computePermission } = require("../middleware/permissions");
const { statsReadLimiter, searchLimiter, autosaveLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const limits = require("../config/statsLimits");

// Panel key (as used in the view's data-component attributes and the client's fetch calls) ->
// the UserPreferences field that hides it. Shared by the panels.json POST below and the
// stats.json GET's gating switch, so the two can never drift on which flag guards which panel.
const PANEL_FIELDS = {
  activity: "hideMessageVolume",
  heatmap: "hideChatActivity",
  clouds: "hideWordCloud",
  mentions: "hideMentions",
};

const router = express.Router();

// Same pattern as routes/accountSettings.js's local requireLogin: no permission-tier check, just
// "is anyone logged in at all". Kept local rather than shared since it's a two-line check and
// each route file that needs it renders its own errors/403 the same way.
function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).render("errors/403", { requiredLevel: null });
  }
  next();
}

function requireLoginJson(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  next();
}

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

router.get("/:channel/user/:username", requireLogin, async (req, res, next) => {
  try {
    const target = await resolveTarget(req, res);
    if (!target) return;
    const { channel, identity } = target;

    const period = limits.resolvePeriod(req.query.period);

    // The TARGET user's privacy flags (not the viewer's) decide what this page shows; the
    // owner check is plain identity equality, deliberately outside the channel tier system -
    // a profile belongs to its user, not to the channel's owner or moderators. The flags
    // themselves are edited on the personal /settings page (routes/accountSettings.js);
    // isOwner only decides whether the hidden stub points there.
    const privacy = await userPreferencesRepo.getPrivacy(identity.userId);
    const isOwner = !!req.user && String(req.user.userId) === String(identity.userId);

    // Goes through the shared display service, NOT profileCacheRepo directly. Reading the cached
    // Twitch colour straight off the profile - which this route used to do - ignores the user's
    // own custom colour from /settings, so the same person rendered in one colour in the nav bar
    // and a different one here, on their own page. The service owns that policy now.
    // Fails soft: the header falls back to a monogram and an undecorated name.
    const profile = await userProfileService.getDisplayProfile(identity.userId);

    // Hidden profile: a stub for EVERYONE - channel owner, mods and admins included (the
    // channel-wide tools on /statistics/chat are unaffected; this hides the per-user showcase).
    // The owner gets the same stub plus a link to /settings, where they can turn it off.
    // No stats are fetched at all - hiding in the view while inlining the data into the
    // bootstrap JSON would hide nothing.
    // Privacy outranks the theme: a hidden profile renders the ordinary stub, not a throne room
    // with the same name on it. The theme document is not even read here - there is nothing on
    // this branch it could decorate.
    if (privacy.hideProfile) {
      return res.render("userDashboard", {
        channel,
        identity,
        profile,
        period,
        periods: limits.PERIODS,
        profileHidden: true,
        theme: resolveTheme(null),
        trophies: [],
        isOwner,
        standing: null,
        activity: null,
        heatmap: null,
        mentions: null,
        clouds: null,
        nicknames: [],
        canModerate: false,
        maxHeatmapDays: limits.MAX_HEATMAP_DAYS,
      });
    }

    const [standing, activity, heatmap, mentions, clouds, permission, themeDoc] = await Promise.all([
      userStatsRepo.getLifetimeStanding(channel.channelLogin, identity.userId),
      // Two reads of the same index range on purpose: the chart needs period-shaped buckets
      // (getMessageVolume), the heatmap always needs the full day-bucketed window.
      // Sections hidden by the privacy flags skip their query entirely - the data must be
      // absent from the response, not just undrawn. clouds/mentions follow the same rule as
      // of the panels.json feature (they used to always fetch - see lib/privacy.js).
      privacy.hideMessageVolume
        ? null
        : userStatsRepo.getMessageVolume(channel.channelLogin, identity.userId, period),
      privacy.hideChatActivity
        ? null
        : userStatsRepo.getDailyMessageCounts(channel.channelLogin, identity.userId),
      privacy.hideMentions ? null : userStatsRepo.getMentionStats(channel.channelLogin, identity, period),
      privacy.hideWordCloud ? null : wordStatsRepo.getUserClouds(channel.channelLogin, identity.userId, period),
      // requireLogin only checks that someone is signed in, not their tier, so
      // req.permissionLevel is unset here - compute it explicitly to decide whether to render
      // the moderator panel.
      computePermission(req.user?.userId ?? null, channel.channelLogin),
      // Keyed by userId, not by channel - the same theme renders on this user's page in every
      // channel (db/pageThemesRepo.js).
      pageThemesRepo.getTheme(identity.userId),
    ]);

    const theme = resolveTheme(themeDoc);
    const nicknames = userStatsRepo.nicknameHistory(identity);

    // Emote images are joined once and shared by the clouds panel and the hero's top-emote tile.
    // The tile used to be handed the raw `clouds` while only the render call got the joined copy,
    // which is why it fell back to printing the emote's NAME instead of showing the emote.
    const cloudsWithImages = clouds
      ? { ...clouds, emotes: await withEmoteImages(channel.channelLogin, clouds.emotes) }
      : null;

    // The hero is a trophy case, not a dashboard: it carries no period switch and does not
    // re-fetch when the panels below it change theirs. So its tiles are ALL-TIME, even while the
    // page around them is showing a week - a number that silently tracks a control somewhere else
    // on the page is worse than a number that never moves. Rank and message count already are
    // (getLifetimeStanding); mentions and the top emote need their own all-time read, which is
    // skipped when the page's period is already "all", when the tile isn't on the hero at all, or
    // when the underlying panel is privacy-hidden.
    let trophies = [];
    if (theme.enabled) {
      const wantsAllTime = period !== "all";
      const heroMentions =
        wantsAllTime && theme.trophies.includes("mentions") && !privacy.hideMentions
          ? await userStatsRepo.getMentionStats(channel.channelLogin, identity, "all")
          : mentions;
      let heroClouds = cloudsWithImages;
      if (wantsAllTime && theme.trophies.includes("topEmote") && !privacy.hideWordCloud) {
        const allTime = await wordStatsRepo.getUserClouds(channel.channelLogin, identity.userId, "all");
        heroClouds = { ...allTime, emotes: await withEmoteImages(channel.channelLogin, allTime.emotes) };
      }
      // Built here rather than in the view: which stat feeds which tile (and which tiles have no
      // value because their panel is hidden) is a rule, and lib/ is where rules go.
      trophies = buildTrophies(theme.trophies, {
        standing,
        mentions: heroMentions,
        clouds: heroClouds,
        identity,
        nicknames,
      });
    }

    res.render("userDashboard", {
      channel,
      identity,
      profile,
      period,
      periods: limits.PERIODS,
      profileHidden: false,
      theme,
      trophies,
      isOwner,
      standing,
      activity,
      heatmap,
      mentions,
      // Spread, don't mutate: getUserClouds results are cached inside wordStatsRepo, and
      // withEmoteImages returns a new array (same contract as the statistics page). null when
      // hideWordCloud is on - nothing to join images into.
      clouds: cloudsWithImages,
      nicknames,
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

router.get("/:channel/user/:username/stats.json", requireLoginJson, statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });
    const identity = await userStatsRepo.findUserByName(req.params.username);
    if (!identity) return res.status(404).json({ error: "unknown_user" });

    // Enforced server-side, not just in the page render: the privacy flags must hold for
    // someone hitting the JSON directly, regardless of viewer tier. This also covers the
    // OWNER's own re-fetch right after flipping a panel back on via panels.json - by the time
    // this runs the flag has already been cleared, so the gate below passes.
    const privacy = await userPreferencesRepo.getPrivacy(identity.userId);
    if (privacy.hideProfile) return res.status(403).json({ error: "profile_hidden" });
    const gateField = PANEL_FIELDS[req.query.component];
    if (gateField && privacy[gateField]) {
      return res.status(403).json({ error: "profile_hidden" });
    }

    const period = limits.resolvePeriod(req.query.period);

    switch (req.query.component) {
      case "clouds": {
        const clouds = await wordStatsRepo.getUserClouds(channel.channelLogin, identity.userId, period);
        // Same image join the page render does - spread, never mutate the repo's cached object.
        return res.json({
          ...clouds,
          emotes: await withEmoteImages(channel.channelLogin, clouds.emotes),
        });
      }
      case "mentions":
        return res.json(await userStatsRepo.getMentionStats(channel.channelLogin, identity, period));
      case "activity":
        return res.json(await userStatsRepo.getMessageVolume(channel.channelLogin, identity.userId, period));
      // No period concept (the heatmap is always the full MAX_HEATMAP_DAYS window) - this case
      // exists purely so the client can pull the data once when the owner flips the panel back
      // on, since the page render never inlined it while the panel was hidden.
      case "heatmap":
        return res.json(await userStatsRepo.getDailyMessageCounts(channel.channelLogin, identity.userId));
      default:
        return res.status(400).json({ error: "unknown_component" });
    }
  } catch (err) {
    next(err);
  }
});

// --- Panel visibility (owner only) -------------------------------------------------------
// Lets the profile owner show/hide a panel directly from the profile page (views/partials/
// panelToggle.ejs) instead of the personal /settings form - see lib/privacy.js. The flags are
// still per-account, not per-channel, so this needs no channel-scoped write; :channel/:username
// only exist in the URL because that's the page the button lives on.

router.post(
  "/:channel/user/:username/panels.json",
  autosaveLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    try {
      const field = PANEL_FIELDS[req.body.panel];
      if (!field) return res.status(400).json({ error: "unknown_panel" });

      const identity = await userStatsRepo.findUserByName(req.params.username);
      if (!identity) return res.status(404).json({ error: "unknown_user" });

      // A panel is that user's own layout choice, same ownership scope as the privacy flags
      // it replaces on /settings - nobody may flip another account's panel.
      if (String(req.user.userId) !== String(identity.userId)) {
        return res.status(403).json({ error: "forbidden" });
      }

      const hidden = req.body.hidden === "1";
      await userPreferencesRepo.savePreferences(identity.userId, { [field]: hidden });
      res.json({ ok: true, panel: req.body.panel, hidden });
    } catch (err) {
      next(err);
    }
  }
);

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

      // hideProfile blocks this endpoint even for tier <= 2 - "hidden from everyone" includes
      // moderators, per the feature's contract. The channel-wide log search on /statistics/chat
      // is deliberately unaffected (it is a channel tool, not this user's profile).
      const privacy = await userPreferencesRepo.getPrivacy(identity.userId);
      if (privacy.hideProfile) return res.status(403).json({ error: "profile_hidden" });

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
