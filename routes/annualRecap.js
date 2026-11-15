// /:channel/recap - the channel's year in chat, and /:channel/recap/:year/me - one viewer's year in
// it. A channel section (Channels.recapEnabled, off by default; a tier-0 admin previews). The
// recap itself is built by jobs/annualRecap.js; these routes only read it.
//
// Two rules shape what is shown where:
//  - punishments of a named person (timeouts, duels, the sniper, the Bureau) appear only on that
//    person's own page, which nobody else can open; the public page shows sums;
//  - anyone may leave the public page (AnnualRecapOptOut). The stored lists carry headroom for
//    that, and the filter runs at render time, so it takes effect at once, without a rebuild.
const express = require("express");
const recapRepo = require("../db/annualRecapRepo");
const userService = require("../db/annualRecapUserService");
const profileCacheRepo = require("../db/profileCacheRepo");
const emoteImages = require("../twitch/emoteImages");
const requireLogin = require("../middleware/requireLogin");
const { verifyToken } = require("../middleware/csrf");
const { loadChannelSection } = require("../middleware/channelSection");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const { buildChannelNav } = require("../lib/channelNav");
const recap = require("../lib/annualRecap");
const gamesCatalog = require("../data/gamesCatalog");

const router = express.Router();
const recapPage = loadChannelSection("recap");
const recapWrite = loadChannelSection("recap", { allowPreview: false });

const SHOWN = 10;

// A personal recap that is not cached yet costs one indexed read of the person's messages; this
// keeps a reload-spammer from turning that into load. Keyed by user id.
const personalLimiter = createSimpleLimiter({ windowMs: 60 * 1000, max: 20 });

function imagesFor(channel) {
  return emoteImages.getEmoteImageMap(channel.channelId, channel.channelLogin).catch(() => new Map());
}

function parseYear(raw) {
  const year = Number(raw);
  return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null;
}

// GameScores keys carry suffixes the catalog does not ("durak-multiplayer", per-channel
// "higher-lower-words-<login>"); the catalog entry whose id the key starts with names it.
function gameNameKey(gameId) {
  const id = String(gameId);
  const entry = gamesCatalog
    .slice()
    .sort((a, b) => b.id.length - a.id.length)
    .find((g) => id === g.id || id.startsWith(`${g.id}-`));
  return entry ? entry.nameKey : null;
}

router.get("/:channel/recap", recapPage, async (req, res, next) => {
  try {
    const years = await recapRepo.listYears(req.channel.channelLogin);
    if (years.length) return res.redirect(`/${req.channel.channelLogin}/recap/${years[0].year}`);
    const broadcaster = await profileCacheRepo.getOrFetchProfile(req.channel.channelId).catch(() => null);
    res.render("annualRecap", {
      channel: req.channel,
      broadcaster,
      channelNav: buildChannelNav(req.channel, { permission: req.permission, active: "recap" }),
      recapDoc: null,
      years: [],
      year: null,
      preview: res.locals.sectionPreview,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:channel/recap/:year", recapPage, async (req, res, next) => {
  try {
    const { channel } = req;
    const year = parseYear(req.params.year);
    if (!year) return res.status(404).render("errors/404");
    const [doc, years] = await Promise.all([
      recapRepo.getChannelRecap(channel.channelLogin, year),
      recapRepo.listYears(channel.channelLogin),
    ]);
    if (!doc) return res.status(404).render("errors/404");
    const d = doc.data;

    const idsShown = [
      ...d.topChatters.map((u) => u.userId),
      ...d.pairs.flatMap((p) => [p.aId, p.bId]),
      ...d.newWords.map((w) => w.by?.userId),
      ...Object.keys(d.firstChatters),
      ...d.commands.map((c) => c.topUserId),
      ...d.ai.askers.map((a) => a.userId),
    ];
    const [hidden, broadcaster, images] = await Promise.all([
      recapRepo.optedOutAmong(idsShown),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      imagesFor(channel),
    ]);
    const visible = (id) => !id || !hidden.has(String(id));

    const topChatters = d.topChatters.filter((u) => visible(u.userId)).slice(0, SHOWN);
    const firstChatters = Object.entries(d.firstChatters)
      .filter(([id]) => visible(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([userId, n]) => ({ userId, n, name: d.topChatters.find((u) => u.userId === userId)?.name || null }));
    const mods = d.moderation.fastest.slice(0, 5);

    const profiles = await profileCacheRepo
      .getOrFetchProfiles([
        ...topChatters.map((u) => u.userId),
        ...firstChatters.map((u) => u.userId),
        ...mods.map((m) => m.userId),
      ])
      .catch(() => new Map());

    // A first chatter outside the top list has no stored login; the profile names them.
    for (const f of firstChatters) if (!f.name) f.name = profiles.get(f.userId)?.login || f.userId;

    res.render("annualRecap", {
      channel,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission: req.permission, active: "recap" }),
      recapDoc: doc,
      years,
      year,
      preview: res.locals.sectionPreview,
      view: {
        topChatters,
        firstChatters,
        mods,
        pairs: d.pairs.filter((p) => visible(p.aId) && visible(p.bId)).slice(0, 6),
        newWords: d.newWords.filter((w) => visible(w.by?.userId)).slice(0, 8),
        commands: d.commands.slice(0, 8).map((c) => ({ ...c, topUserId: visible(c.topUserId) ? c.topUserId : null })),
        askers: d.ai.askers.filter((a) => visible(a.userId)).slice(0, 5),
        profiles,
        images,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:channel/recap/:year/me", recapPage, async (req, res, next) => {
  try {
    const { channel } = req;
    const year = parseYear(req.params.year);
    if (!year) return res.status(404).render("errors/404");
    const doc = await recapRepo.getChannelRecap(channel.channelLogin, year);
    if (!doc) return res.status(404).render("errors/404");

    const common = {
      channel,
      channelNav: buildChannelNav(channel, { permission: req.permission, active: "recap" }),
      year,
      recapDoc: doc,
      preview: res.locals.sectionPreview,
    };
    if (!req.user) return res.render("annualRecapMe", { ...common, needLogin: true });
    if (!personalLimiter(String(req.user.userId))) return res.status(429).send("Too many requests");

    const [personal, optedOut, images, broadcaster] = await Promise.all([
      userService.getUserRecap(channel, year, req.user.userId, doc),
      recapRepo.isOptedOut(req.user.userId),
      imagesFor(channel),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
    ]);

    const quiz = personal.empty
      ? []
      : recap.buildQuiz(personal, {
          channelEmotes: doc.data.emotes.top.map((e) => e.word),
          channelChatters: doc.data.topChatters.map((u) => u.name).filter(Boolean),
          seed: `${channel.channelLogin}:${year}:${req.user.userId}`,
        });

    res.render("annualRecapMe", {
      ...common,
      broadcaster,
      needLogin: false,
      personal,
      quiz,
      optedOut,
      images,
      gameNameKey,
      messageBuckets: recap.MESSAGE_BUCKETS,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/recap/privacy", recapWrite, requireLogin, verifyToken, async (req, res, next) => {
  try {
    await recapRepo.setOptOut(req.user.userId, req.body.hidden === "1");
    const year = parseYear(req.body.year);
    res.redirect(year ? `/${req.channel.channelLogin}/recap/${year}/me#privacy` : `/${req.channel.channelLogin}/recap`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
