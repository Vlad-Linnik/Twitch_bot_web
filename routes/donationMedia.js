// Donation media ("медиа за донат"): YouTube clips that viewers attach to a donation on
// DonationAlerts, Donatello or DonatePay, gathered into one queue per channel and played in OBS.
//
//   /:channel/settings/donation-media         the owner's setup page: the platform keys and the
//                                              two OBS links. Level 1 - the keys read every donation
//                                              of the channel, donor names included.
//   /:channel/settings/donation-media/queue   the queue panel on the site, for moderators. Control
//                                              follows the "donationMedia" moderator section; the
//                                              rest see it read-only.
//   /:channel/settings/donation-media/placeholders   the pictures a clip is covered with, for the
//                                              same moderators.
//   /obs/donation-media/:key/player           the OBS browser source (no login: the key is the
//   /obs/donation-media/:key/panel            credential) and the OBS dock panel.
//
// The live part - the listeners, the queue, the socket - is realtime/donationMediaManager.js.
const express = require("express");
const multer = require("multer");
const channelsRepo = require("../db/channelsRepo");
const donationMediaRepo = require("../db/donationMediaRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const donationMediaManager = require("../realtime/donationMediaManager");
const { requireLevel, requireSectionEditAccess, exposeSectionEditAccess } = require("../middleware/permissions");
const { settingsNav } = require("../middleware/settingsNav");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const {
  DA_CURRENCIES,
  DEFAULT_DA_CURRENCY,
  parseDonationAlertsToken,
  parseDonationAlertsCurrency,
  parseDonatelloWidgetLink,
  parseDonatePayWidget,
  maskSecret,
} = require("../lib/donationMedia");
const { resolveDonatelloUserId } = require("../lib/donatelloWidgetPage");
const placeholder = require("../lib/donationMediaPlaceholder");
const icons = require("../lib/donationMediaIcons");
const { ACTIONS: ACTION_LOG_ACTIONS } = require("../lib/donationMediaActionLog");
const iconImage = require("../lib/donationMediaIconImage");
const emoteImages = require("../twitch/emoteImages");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const { extractVideoId } = require("../lib/donationMedia");

const router = express.Router();

const PLATFORMS = ["donationAlerts", "donatello", "donatePay"];

// The OBS pages run the YouTube IFrame API, which the site-wide policy (app.js) does not allow:
// its script, the player frame, the thumbnails. Replaced on these responses only. The panel's own
// script and styles are ours, so 'self' covers them; no inline script is used.
const OBS_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' data: https://i.ytimg.com https://cdn.7tv.app",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// The panel script's strings (public/js/donation-media-panel.js), handed over in a data attribute.
const PANEL_STRING_KEYS = [
  "offline", "readOnly", "keyReplaced", "player", "playerOff",
  "nowPlaying", "nothingPlaying", "waitingForPlayer", "paused", "pause", "resume", "skip", "restart", "seek",
  "queue", "queueEmpty", "moveTop", "dragHint", "remove", "add", "addPlaceholder",
  "history", "historyEmpty", "clearHistory", "requeue", "requeueHint", "playNext", "playNextHint",
  "anonymous", "manual", "addedBy", "replay",
  "coverLabel", "coverNone", "coverHide", "coverBlur", "coverImage", "coverImagePick", "coverBuiltin", "coverOwn", "coverHint", "coverActive", "blurStrength", "volume", "volumeHint",
  "playlist", "playlistAuto", "playlistAutoHint", "infinite", "infiniteHint", "musicNovelty", "musicNoveltyHint", "novelty.known", "novelty.even", "novelty.new",
  "musicMood", "musicMoodHint", "mood.calm", "mood.any", "mood.lively", "hideMusic", "hideMusicHint", "playlistEmpty", "playlistAdd", "playlistDuplicate",
  "playlistFull", "playlistStalled", "playlistBadge", "playlistNowPlaying", "like", "likeHint", "liked", "likedHint", "dislike", "dislikeHint", "disliked", "dislikedHint",
  "upNext", "upNextHint", "upNextEmpty", "upNextClear", "upNextPlay", "upNextBadge", "radio", "radioHint", "radioOn", "radioStop", "radioNothing", "moreArtist", "moreArtistHint", "moreArtistNothing", "aiPlaceholder", "aiSubmit", "aiNoKey", "aiFailed", "aiNothing", "added", "searching", "source.graph", "source.playlist", "source.mix", "source.lastfm", "source.author", "source.ai",
  "status.skipped", "status.removed", "status.error",
  "failure.blocked", "failure.uaLaw", "failure.uaLawLink", "failure.only", "failure.blockedCount", "failure.removed", "failure.embed", "failure.badId", "failure.html5", "failure.code",
  "log.title", "log.empty", "log.everyone", "log.more", "log.via.chat", "log.via.dock", "log.on", "log.off", "log.place", "log.tracks",
  ...ACTION_LOG_ACTIONS.map((a) => `log.do.${a}`),
];

function panelStrings(t) {
  return Object.fromEntries(PANEL_STRING_KEYS.map((k) => [k, t(`donationMedia.panel.${k}`)]));
}

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// The site's own address for the OBS links. Behind the proxy `trust proxy` makes req.protocol the
// visitor's https.
function siteOrigin(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function obsLinks(req, config) {
  const origin = siteOrigin(req);
  // ?lang= pins the OBS page to the language the owner reads the setup page in - OBS's browser
  // has no account and would otherwise guess from its own Accept-Language.
  const lang = `?lang=${encodeURIComponent(req.locale || "en")}`;
  return {
    player: `${origin}/obs/donation-media/${config.playerKey}/player${lang}`,
    panel: `${origin}/obs/donation-media/${config.panelKey}/panel${lang}`,
  };
}

// What the setup page shows of a stored platform: whether it is there, and enough of the secret to
// recognise it. The secret itself never goes back to the browser.
function platformView(config) {
  return {
    donationAlerts: config.donationAlerts
      ? { masked: maskSecret(config.donationAlerts.token), currency: config.donationAlerts.currency || DEFAULT_DA_CURRENCY }
      : null,
    donatello: config.donatello
      ? { masked: maskSecret(config.donatello.userId), widgetMasked: maskSecret(config.donatello.widgetId) }
      : null,
    donatePay: config.donatePay ? { masked: maskSecret(config.donatePay.token), host: new URL(config.donatePay.origin).host } : null,
  };
}

router.get("/:channel/settings/donation-media", requireLevel(1), settingsNav("donationMediaSetup"), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;
    const config = await donationMediaRepo.getOrCreate(channel);
    res.render("donationMediaSetup", {
      channel,
      links: obsLinks(req, config),
      platforms: platformView(config),
      status: donationMediaManager.statusOf(channel.channelId),
      currencies: DA_CURRENCIES,
      historyLimit: config.historyLimit,
      historyMin: icons.HISTORY_MIN,
      historyMax: icons.HISTORY_MAX,
      saved: typeof req.query.saved === "string" ? req.query.saved : null,
      error: typeof req.query.error === "string" ? req.query.error : null,
      errorPlatform: typeof req.query.platform === "string" ? req.query.platform : null,
    });
  } catch (err) {
    next(err);
  }
});

const ERROR_KEYS = new Set(["empty", "daToken", "donatelloLink", "donatelloNotMedia", "donatelloUnreachable", "dpHost", "dpToken"]);

router.post(
  "/:channel/settings/donation-media",
  settingsWriteLimiter,
  requireLevel(1),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      await donationMediaRepo.getOrCreate(channel);
      const back = `/${channel.channelLogin}/settings/donation-media`;
      const action = String(req.body.action || "");
      const platform = String(req.body.platform || "");
      const fail = (error, anchor) =>
        res.redirect(`${back}?error=${ERROR_KEYS.has(error) ? error : "empty"}&platform=${anchor}#${anchor}`);

      // Nothing secret goes into the change log - only which platform and what happened.
      const log = (logAction, target) =>
        settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin,
          user: req.user,
          category: "donation_media",
          action: logAction,
          target,
          before: null,
          after: null,
        });

      if (action === "saveDonationAlerts") {
        const currency = parseDonationAlertsCurrency(req.body.currency);
        const existing = await donationMediaRepo.findByChannelId(channel.channelId);
        // An empty token field with DonationAlerts already connected changes the currency only.
        if (!String(req.body.token || "").trim() && existing && existing.donationAlerts) {
          await donationMediaRepo.setDonationAlertsCurrency(channel.channelId, currency);
        } else {
          const parsed = parseDonationAlertsToken(req.body.token);
          if (!parsed.ok) return fail(parsed.error, "donationAlerts");
          await donationMediaRepo.setDonationAlerts(channel.channelId, { token: parsed.token, currency });
        }
        await log("connect", "donationAlerts");
      } else if (action === "saveDonatello") {
        const link = parseDonatelloWidgetLink(req.body.widget);
        if (!link.ok) return fail(link.error, "donatello");
        const page = await resolveDonatelloUserId(link);
        if (!page.ok) return fail(page.error, "donatello");
        await donationMediaRepo.setDonatello(channel.channelId, { userId: page.userId, widgetId: link.widgetId });
        await log("connect", "donatello");
      } else if (action === "saveDonatePay") {
        const parsed = parseDonatePayWidget(req.body.widget);
        if (!parsed.ok) return fail(parsed.error, "donatePay");
        await donationMediaRepo.setDonatePay(channel.channelId, { token: parsed.token, origin: parsed.origin });
        await log("connect", "donatePay");
      } else if (action === "clear" && PLATFORMS.includes(platform)) {
        await donationMediaRepo.clearPlatform(channel.channelId, platform);
        await log("disconnect", platform);
      } else if (action === "regenerate") {
        await donationMediaRepo.regenerateKeys(channel.channelId);
        await log("regenerate", "links");
      } else {
        return res.redirect(back);
      }

      await donationMediaManager.reload(channel.channelId, channel.channelLogin);
      const anchor = action === "regenerate" ? "links" : action === "clear" ? platform : action.replace(/^save/, "").replace(/^./, (c) => c.toLowerCase());
      return res.redirect(`${back}?saved=${action === "regenerate" ? "links" : action === "clear" ? "cleared" : "connected"}#${anchor}`);
    } catch (err) {
      next(err);
    }
  }
);

// The channel's placeholder pictures (lib/donationMediaPlaceholder.js). Its own route because it is
// the one multipart form: multer must read the body before the CSRF check can. It follows the
// queue's access - every moderator who may control the queue (section "donationMedia") - rather
// than the platform keys' level 1: a placeholder is what the moderator on duty needs when a clip turns out unfit, and every change
// is in the settings change log under their name.
const placeholderUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: placeholder.MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 1024 },
});

function readPlaceholderUpload(req, res, next) {
  placeholderUpload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.placeholderUploadError = err.code === "LIMIT_FILE_SIZE" ? "too_large" : "not_allowed_type";
      return next();
    }
    next(err);
  });
}

const PLACEHOLDER_ERRORS = { not_allowed_type: "phType", unreadable: "phType", too_large: "phTooLarge", empty: "phEmpty", full: "phFull" };

router.get(
  "/:channel/settings/donation-media/placeholders",
  requireLevel(2),
  exposeSectionEditAccess("donationMedia"),
  settingsNav("donationMediaPlaceholders"),
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      const config = await donationMediaRepo.findByChannelId(channel.channelId);
      res.render("donationMediaPlaceholders", {
        channel,
        placeholders: config ? config.placeholders : [],
        placeholderMax: placeholder.MAX_PLACEHOLDERS,
        saved: typeof req.query.saved === "string" ? req.query.saved : null,
        error: typeof req.query.error === "string" ? req.query.error : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:channel/settings/donation-media/placeholders",
  settingsWriteLimiter,
  requireSectionEditAccess("donationMedia"),
  readPlaceholderUpload,
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      const config = await donationMediaRepo.getOrCreate(channel);
      const back = `/${channel.channelLogin}/settings/donation-media/placeholders`;
      const fail = (code) => res.redirect(`${back}?error=${PLACEHOLDER_ERRORS[code] || "phType"}`);

      const removing = req.body.action === "remove";
      if (removing) {
        const entry = config.placeholders.find((p) => p.id === req.body.id);
        const removed = entry && (await donationMediaRepo.removePlaceholder(channel.channelId, entry.url));
        if (!removed) return res.redirect(back);
        // First the players and panels let go of the picture, then its files go.
        await donationMediaManager.reloadPanelSettings(channel.channelId, channel.channelLogin);
        await placeholder.deletePlaceholder(removed);
      } else {
        if (req.placeholderUploadError) return fail(req.placeholderUploadError);
        if (!req.file || !req.file.buffer || req.file.buffer.length === 0) return fail("empty");
        if (config.placeholders.length >= placeholder.MAX_PLACEHOLDERS) return fail("full");
        let entry;
        try {
          entry = await placeholder.savePlaceholder(req.file.buffer);
        } catch (err) {
          if (err instanceof placeholder.PlaceholderError) return fail(err.code);
          throw err;
        }
        if (!(await donationMediaRepo.addPlaceholder(channel.channelId, entry))) {
          await placeholder.deletePlaceholder(entry);
          return fail("full");
        }
        await donationMediaManager.reloadPanelSettings(channel.channelId, channel.channelLogin);
      }
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin,
        user: req.user,
        category: "donation_media",
        action: removing ? "disconnect" : "connect",
        target: "placeholder",
        before: null,
        after: null,
      });
      await donationMediaManager.logSiteAction(channel.channelId, channel.channelLogin, req.user, { action: removing ? "placeholderRemove" : "placeholderAdd" });
      return res.redirect(`${back}?saved=${removing ? "placeholderRemoved" : "placeholder"}`);
    } catch (err) {
      next(err);
    }
  }
);

// --- the queue panel's buttons and history (owner only) -------------------------------------------

// The button theme has a settings page of its own under "Widgets"; the history length stays on the
// setup page. Both save through the POST below.
router.get("/:channel/settings/donation-media/buttons", requireLevel(1), settingsNav("donationMediaButtons"), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;
    const config = await donationMediaRepo.getOrCreate(channel);
    res.render("donationMediaButtons", {
      channel,
      buttons: config.buttons,
      iconSlots: icons.SLOTS,
      sevenTvTheme: icons.resolveIcons({ theme: "7tv" }),
      customIcons: icons.resolveIcons({ theme: "custom", custom: config.buttons.custom }),
      iconErrorNames: typeof req.query.names === "string" ? req.query.names.slice(0, 120) : "",
      saved: typeof req.query.saved === "string" ? req.query.saved : null,
      error: typeof req.query.error === "string" ? req.query.error : null,
      errorPlatform: "buttons",
    });
  } catch (err) {
    next(err);
  }
});

const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: iconImage.MAX_UPLOAD_BYTES, files: 1, fields: 8, parts: 9, fieldSize: 2048 },
});

function readIconUpload(req, res, next) {
  iconUpload.single("image")(req, res, (err) => {
    if (err) {
      req.iconUploadError = err.code === "LIMIT_FILE_SIZE" ? "too_large" : "not_allowed_type";
      return next();
    }
    next();
  });
}

// "pepeJAM Tssk", "https://7tv.app/emotes/<id>", a bare id - up to MAX_ICONS_PER_SLOT, separated by
// spaces or commas. A name is looked up in the channel's own 7TV set first, then in 7TV's global
// set. `channelIds`: one channel, or several (the admin's Easter eggs belong to no channel, so
// their names are looked up in every channel's set). Resolves to { icons, unknown: [names not found] }.
async function resolveIconRefs(text, channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  const tokens = String(text || "").split(/[\s,]+/).filter(Boolean).slice(0, icons.MAX_ICONS_PER_SLOT);
  const out = [];
  const unknown = [];
  let channelSet = null;
  let globalSet = null;
  for (const token of tokens) {
    const id = icons.parseSevenTvRef(token);
    if (id) {
      out.push({ kind: "7tv", id });
      continue;
    }
    if (!/^[\w:().!?-]{1,40}$/.test(token)) {
      unknown.push(token.slice(0, 40));
      continue;
    }
    if (!channelSet) {
      channelSet = new Map();
      for (const channelId of ids) {
        const user = await emoteImages.getSevenTvUser(channelId, { complete: true }).catch(() => null);
        for (const e of (user && user.emote_set && user.emote_set.emotes) || []) if (!channelSet.has(e.name)) channelSet.set(e.name, e.id);
      }
    }
    let found = channelSet.get(token);
    if (!found) {
      if (!globalSet) {
        const map = await emoteImages.getSevenTvGlobalImages({ complete: true }).catch(() => new Map());
        globalSet = new Map([...map].map(([name, url]) => [name, (String(url).match(/\/emote\/([^/]+)\//) || [])[1]]));
      }
      found = globalSet.get(token);
    }
    if (found && icons.parseSevenTvRef(found)) out.push({ kind: "7tv", id: found });
    else unknown.push(token);
  }
  return { icons: out, unknown };
}

const ICON_ERRORS = { not_allowed_type: "iconType", unreadable: "iconType", too_large: "iconTooLarge" };

router.post(
  "/:channel/settings/donation-media/buttons",
  settingsWriteLimiter,
  requireLevel(1),
  readIconUpload,
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      const config = await donationMediaRepo.getOrCreate(channel);
      const setup = `/${channel.channelLogin}/settings/donation-media`;
      const back = `${setup}/buttons`;
      const fail = (code, extra = "") => res.redirect(`${back}?error=${code}${extra}`);
      const action = req.body.action;

      if (action === "history") {
        await donationMediaRepo.setHistoryLimit(channel.channelId, req.body.historyLimit);
        await donationMediaManager.reloadPanelSettings(channel.channelId, channel.channelLogin);
        await settingsChangeLogRepo.logChange({ channelLogin: channel.channelLogin, user: req.user, category: "donation_media", action: "update", target: "historyLimit", before: null, after: null });
        return res.redirect(`${setup}?saved=history#history`);
      }

      const next_ = { theme: config.buttons.theme, custom: { ...config.buttons.custom } };
      if (action === "theme") {
        if (!icons.THEMES.includes(req.body.theme)) return fail("iconTheme");
        next_.theme = req.body.theme;
      } else if (action === "slot") {
        const slot = req.body.slot;
        if (!icons.SLOT_KEYS.includes(slot)) return fail("iconSlot");
        if (req.body.reset === "1") {
          delete next_.custom[slot];
        } else {
          if (req.iconUploadError) return fail(ICON_ERRORS[req.iconUploadError] || "iconType");
          const { icons: resolved, unknown } = await resolveIconRefs(req.body.refs, channel.channelId);
          if (unknown.length) return fail("iconUnknown", `&names=${encodeURIComponent(unknown.join(" ").slice(0, 120))}`);
          const list = resolved;
          if (req.file && req.file.buffer && req.file.buffer.length) {
            try {
              list.push({ kind: "upload", url: await iconImage.saveIcon(req.file.buffer) });
            } catch (err) {
              if (err instanceof iconImage.PlaceholderError) return fail(ICON_ERRORS[err.code] || "iconType");
              throw err;
            }
          }
          if (list.length === 0) return fail("iconEmpty");
          next_.custom[slot] = list.slice(0, icons.MAX_ICONS_PER_SLOT);
        }
        // Editing a slot means the custom theme is the one wanted.
        next_.theme = "custom";
      } else {
        return fail("iconSlot");
      }

      const before = await donationMediaRepo.setButtons(channel.channelId, next_);
      const kept = new Set(iconImage.uploadsIn(icons.normalizeButtons(next_).custom));
      for (const url of iconImage.uploadsIn(before.custom)) if (!kept.has(url)) await iconImage.deleteIcon(url);
      await donationMediaManager.reloadPanelSettings(channel.channelId, channel.channelLogin);
      await settingsChangeLogRepo.logChange({ channelLogin: channel.channelLogin, user: req.user, category: "donation_media", action: "update", target: "buttons", before: null, after: null });
      return res.redirect(`${back}?saved=buttons`);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:channel/settings/donation-media/queue",
  requireLevel(2),
  exposeSectionEditAccess("donationMedia"),
  settingsNav("donationMediaQueue"),
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      const config = await donationMediaRepo.findByChannelId(channel.channelId);
      res.render("donationMediaQueue", {
        channel,
        configured: Boolean(config && (config.donationAlerts || config.donatello || config.donatePay)),
        isOwner: req.permissionLevel <= 1,
        panelStrings: panelStrings(res.locals.t),
      });
    } catch (err) {
      next(err);
    }
  }
);

// --- OBS ---------------------------------------------------------------------------------------

function obsPage(role, view) {
  return async (req, res, next) => {
    try {
      const found = await donationMediaRepo.findByKey(req.params.key);
      if (!found || found.role !== role) return res.status(404).type("text/plain").send("Not found");
      res.setHeader("Content-Security-Policy", OBS_CSP);
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Cache-Control", "no-store");
      res.render(view, {
        key: req.params.key,
        channelLogin: found.channelLogin,
        placeholderUrl: found.placeholderUrl,
        panelStrings: panelStrings(res.locals.t),
      });
    } catch (err) {
      next(err);
    }
  };
}

// --- Easter eggs: the site admin's, for every channel ---------------------------------------------
// While one particular video plays, some panel buttons wear other icons (lib/donationMediaIcons.js).

router.get("/admin/donation-media/eggs", requireLevel(0), async (req, res, next) => {
  try {
    const list = await donationMediaRepo.listEggs();
    res.render("adminDonationMediaEggs", {
      tab: "donation-eggs",
      eggs: list.map((egg) => ({ ...egg, resolved: icons.resolveIcons(null, egg.icons) })),
      iconSlots: icons.SLOTS,
      saved: typeof req.query.saved === "string" ? req.query.saved : null,
      error: typeof req.query.error === "string" ? req.query.error : null,
      errorNames: typeof req.query.names === "string" ? req.query.names.slice(0, 120) : "",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/donation-media/eggs", settingsWriteLimiter, requireLevel(0), readIconUpload, verifyToken, async (req, res, next) => {
  try {
    const back = "/admin/donation-media/eggs";
    const fail = (code, extra = "") => res.redirect(`${back}?error=${code}${extra}`);
    const eggList = await donationMediaRepo.listEggs();
    const action = req.body.action;
    const videoId = extractVideoId(typeof req.body.video === "string" ? req.body.video.slice(0, 300) : "");
    if (!videoId) return fail("eggVideo");
    const existing = eggList.find((e) => e.videoId === videoId);

    if (action === "delete") {
      const removed = await donationMediaRepo.deleteEgg(videoId);
      if (removed) for (const url of iconImage.uploadsIn(removed.icons)) await iconImage.deleteIcon(url);
    } else {
      const slot = req.body.slot;
      if (!icons.SLOT_KEYS.includes(slot)) return fail("iconSlot");
      const egg = { videoId, icons: { ...(existing ? existing.icons : {}) }, note: typeof req.body.note === "string" ? req.body.note : existing ? existing.note : "" };
      const replaced = egg.icons[slot] || [];
      if (action === "removeSlot") {
        delete egg.icons[slot];
      } else {
        if (req.iconUploadError) return fail(ICON_ERRORS[req.iconUploadError] || "iconType");
        const channels = await channelsRepo.listAll().catch(() => []);
        const { icons: resolved, unknown } = await resolveIconRefs(req.body.refs, channels.map((c) => String(c.channelId)));
        if (unknown.length) return fail("iconUnknown", `&names=${encodeURIComponent(unknown.join(" ").slice(0, 120))}`);
        if (req.file && req.file.buffer && req.file.buffer.length) {
          try {
            resolved.push({ kind: "upload", url: await iconImage.saveIcon(req.file.buffer) });
          } catch (err) {
            if (err instanceof iconImage.PlaceholderError) return fail(ICON_ERRORS[err.code] || "iconType");
            throw err;
          }
        }
        if (resolved.length === 0) return fail("iconEmpty");
        egg.icons[slot] = resolved.slice(0, icons.MAX_ICONS_PER_SLOT);
      }
      if (Object.keys(egg.icons).length === 0) await donationMediaRepo.deleteEgg(videoId);
      else await donationMediaRepo.saveEgg(egg, req.user && req.user.login);
      const kept = new Set(iconImage.uploadsIn(egg.icons));
      for (const url of iconImage.uploadsIn({ [slot]: replaced })) if (!kept.has(url)) await iconImage.deleteIcon(url);
    }
    await adminActionLogsRepo.logAction({ admin: req.user, action: `donationMediaEgg.${action === "delete" ? "delete" : "save"}`, target: videoId });
    await donationMediaManager.reloadEggs();
    return res.redirect(`${back}?saved=1`);
  } catch (err) {
    next(err);
  }
});

router.get("/obs/donation-media/:key/player", obsPage("player", "donationMediaPlayer"));
router.get("/obs/donation-media/:key/panel", obsPage("panel", "donationMediaObsPanel"));

module.exports = router;
module.exports.PANEL_STRING_KEYS = PANEL_STRING_KEYS;
