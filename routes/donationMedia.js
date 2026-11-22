// Donation media ("медиа за донат"): YouTube clips that viewers attach to a donation on
// DonationAlerts, Donatello or DonatePay, gathered into one queue per channel and played in OBS.
//
//   /:channel/settings/donation-media         the owner's setup page: the platform keys and the
//                                              two OBS links. Level 1 - the keys read every donation
//                                              of the channel, donor names included.
//   /:channel/settings/donation-media/queue   the queue panel on the site, for moderators. Control
//                                              follows the "donationMedia" moderator section; the
//                                              rest see it read-only.
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

const router = express.Router();

const PLATFORMS = ["donationAlerts", "donatello", "donatePay"];

// The OBS pages run the YouTube IFrame API, which the site-wide policy (app.js) does not allow:
// its script, the player frame, the thumbnails. Replaced on these responses only. The panel's own
// script and styles are ours, so 'self' covers them; no inline script is used.
const OBS_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' data: https://i.ytimg.com",
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
  "coverLabel", "coverNone", "coverHide", "coverBlur", "coverImage", "coverHint", "coverActive", "blurStrength", "volume", "volumeHint",
  "playlist", "playlistAuto", "playlistAutoHint", "infinite", "infiniteHint", "playlistEmpty", "playlistAdd", "playlistDuplicate",
  "playlistFull", "playlistStalled", "playlistBadge", "playlistNowPlaying", "toPlaylist", "toPlaylistHint", "inPlaylist",
  "upNext", "upNextHint", "upNextEmpty", "upNextClear", "upNextPlay", "upNextBadge", "radio", "radioHint", "radioOn", "radioStop", "radioNothing", "moreArtist", "moreArtistHint", "moreArtistNothing", "aiPlaceholder", "aiSubmit", "aiNoKey", "aiFailed", "aiNothing", "added", "searching", "source.mix", "source.lastfm", "source.author", "source.ai",
  "status.skipped", "status.removed", "status.error",
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
      placeholderUrl: config.placeholderUrl,
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

// The channel's placeholder picture (lib/donationMediaPlaceholder.js). Its own route because it is
// the one multipart form: multer must read the body before the CSRF check can. Uploaded from the
// owner's setup page or from the queue page, so it follows the queue's access - every moderator
// who may control the queue (section "donationMedia") - rather than the platform keys' level 1:
// a placeholder is what the moderator on duty needs when a clip turns out unfit, and every change
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

const PLACEHOLDER_ERRORS = { not_allowed_type: "phType", unreadable: "phType", too_large: "phTooLarge", empty: "phEmpty" };

router.post(
  "/:channel/settings/donation-media/placeholder",
  settingsWriteLimiter,
  requireSectionEditAccess("donationMedia"),
  readPlaceholderUpload,
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      await donationMediaRepo.getOrCreate(channel);
      const fromQueue = req.body.from === "queue";
      const back = `/${channel.channelLogin}/settings/donation-media${fromQueue ? "/queue" : ""}`;
      const fail = (code) => res.redirect(`${back}?error=${PLACEHOLDER_ERRORS[code] || "phType"}&platform=placeholder#placeholder`);

      let url = null;
      if (req.body.action !== "reset") {
        if (req.placeholderUploadError) return fail(req.placeholderUploadError);
        if (!req.file || !req.file.buffer || req.file.buffer.length === 0) return fail("empty");
        try {
          url = await placeholder.savePlaceholder(req.file.buffer);
        } catch (err) {
          if (err instanceof placeholder.PlaceholderError) return fail(err.code);
          throw err;
        }
      }
      const previous = await donationMediaRepo.setPlaceholder(channel.channelId, url);
      if (previous && previous !== url) await placeholder.deletePlaceholder(previous);
      donationMediaManager.setPlaceholder(channel.channelId, url);
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin,
        user: req.user,
        category: "donation_media",
        action: url ? "connect" : "disconnect",
        target: "placeholder",
        before: null,
        after: null,
      });
      return res.redirect(`${back}?saved=${url ? "placeholder" : "placeholderReset"}#placeholder`);
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
        placeholderUrl: config && placeholder.isPlaceholderUrl(config.placeholderUrl) ? config.placeholderUrl : null,
        saved: typeof req.query.saved === "string" ? req.query.saved : null,
        error: typeof req.query.error === "string" ? req.query.error : null,
        errorPlatform: typeof req.query.platform === "string" ? req.query.platform : null,
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
        placeholderUrl: placeholder.isPlaceholderUrl(found.placeholderUrl) ? found.placeholderUrl : null,
        panelStrings: panelStrings(res.locals.t),
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get("/obs/donation-media/:key/player", obsPage("player", "donationMediaPlayer"));
router.get("/obs/donation-media/:key/panel", obsPage("panel", "donationMediaObsPanel"));

module.exports = router;
module.exports.PANEL_STRING_KEYS = PANEL_STRING_KEYS;
