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
const { isKnownBotName } = require("../config/knownBots");
const { resolveHeadingEmotes } = require("../lib/recapHeadingEmotes");
const { readableChatColor } = require("../lib/readableColor");
const { getBoxArtUrls } = require("../twitch/gameBoxArt");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const gameCatalogRepo = require("../db/gameCatalogRepo");
const axios = require("axios");
const { isAllowedImageUrl } = require("../lib/emoteImageHosts");
const { categoryKey } = require("../lib/streamHours");
const { canEditSectionAt } = require("../middleware/permissions");
const { canModerateDiscussion } = require("../lib/discussion");

const MOMENTS_SHOWN = 6;

// Removing a loud moment is moderation of what the page shows, so it follows the same right as
// hiding a comment: the site admin, the owner, and moderators the owner left "discussions" to.
async function canModerateMoments(req) {
  if (!req.user) return false;
  return (
    canModerateDiscussion(req.permission) &&
    (await canEditSectionAt(req.permission, req.channel.channelId, req.user.userId, "discussions"))
  );
}

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
function gameEntry(gameId) {
  const id = String(gameId);
  return (
    gamesCatalog
      .slice()
      .sort((a, b) => b.id.length - a.id.length)
      .find((g) => id === g.id || id.startsWith(`${g.id}-`)) || null
  );
}

// Catalog ids the site admin hid on /admin/games. Read at render time, so hiding a game takes it off
// every recap at once, without a rebuild. Fail-soft: a read error hides nothing.
async function hiddenGameIds() {
  const settings = await gameCatalogRepo.getSettingsMap().catch(() => new Map());
  return new Set([...settings.entries()].filter(([, v]) => v && v.hidden).map(([id]) => id));
}

// Only games of the catalog that are not hidden.
const shownGame = (hidden) => (gameId) => {
  const entry = gameEntry(gameId);
  return Boolean(entry && !hidden.has(entry.id));
};

// Where a stream category leads on our site: the channel's own card for that game when there is one,
// else the channel's games page. Nothing when the games section is off (a link to a 404), except for
// the site admin, who previews switched-off sections anyway.
async function categoryLinks(channel, names, permission) {
  if (!channel.gamesEnabled && permission !== 0) return new Map();
  const base = `/${channel.channelLogin}/games`;
  const items = await mediaItemsRepo.listForGrid(channel.channelLogin, "game", ["accepted", "done"]).catch(() => []);
  const byKey = new Map();
  for (const item of items) {
    for (const name of [item.external?.twitchCategoryName, item.title]) {
      if (name && !byKey.has(categoryKey(name))) byKey.set(categoryKey(name), `${base}/${item._id}`);
    }
  }
  return new Map(names.map((n) => [n, byKey.get(categoryKey(n)) || base]));
}

// What a site game's GameScores number is. The online games keep an Elo rating there (realtime/
// durakElo.js, quickMatchManager), the offline Durak a count of wins, every other game its record -
// three different things that must not share a caption. Online Durak shares its catalog card with
// the offline one, so it gets a name of its own.
const RATING_GAMES = new Set(["durak-multiplayer", "battleship", "pong", "connect-four", "sunduchki-multiplayer", "backgammon"]);
function siteGameMeta(gameId) {
  const id = String(gameId);
  if (id === "durak-multiplayer") return { unit: "rating", titleKey: "recap.siteGames.durakOnline" };
  if (id === "durak") return { unit: "wins", titleKey: null };
  return { unit: RATING_GAMES.has(id) ? "rating" : "best", titleKey: null };
}

const notBot = (profiles) => (m) => {
  const p = profiles.get(String(m.userId));
  return !isKnownBotName(p?.login) && !isKnownBotName(p?.displayName) && !isKnownBotName(m.userId);
};

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
    const [doc, years, picks, hiddenMoments, momentsModerator] = await Promise.all([
      recapRepo.getChannelRecap(channel.channelLogin, year),
      recapRepo.listYears(channel.channelLogin),
      recapRepo.listPicks(channel.channelLogin, year),
      recapRepo.hiddenMomentsOf(channel.channelLogin, year),
      canModerateMoments(req),
    ]);
    if (!doc) return res.status(404).render("errors/404");
    const d = doc.data;

    const idsShown = [
      ...d.topChatters.map((u) => u.userId),
      ...d.pairs.flatMap((p) => [p.aId, p.bId]),
      ...d.newWords.map((w) => w.by?.userId),
      ...Object.keys(d.firstChatters),
      ...d.commands.map((c) => c.topUserId),
      ...picks.map((p) => p.userId),
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
    const pairs = d.pairs.filter((p) => visible(p.aId) && visible(p.bId)).slice(0, 6);
    const newWords = d.newWords.filter((w) => visible(w.by?.userId)).slice(0, 8);
    const mod = d.moderation;
    const isShownGame = shownGame(await hiddenGameIds());
    const siteGames = (d.siteGames || [])
      .filter((g) => isShownGame(g.game))
      .map((g) => ({ ...g, ...siteGameMeta(g.game), entry: gameEntry(g.game), top: g.top.filter((u) => visible(u.userId)) }))
      .filter((g) => g.top.length);
    const cats = d.categories.list.slice(0, 8);

    // Everyone the page names gets an avatar and their chat colour; one batched profile read.
    const [profiles, boxArt, catLinks] = await Promise.all([
      profileCacheRepo
        .getOrFetchProfiles([
          ...topChatters.map((u) => u.userId),
          ...firstChatters.map((u) => u.userId),
          ...pairs.flatMap((p) => [p.aId, p.bId]),
          ...newWords.map((w) => w.by?.userId),
          ...["fastest", "mostActions", "longestGiven", "presence"].flatMap((k) => (mod[k] || []).map((m) => m.userId)),
          ...siteGames.flatMap((g) => g.top.map((u) => u.userId)),
          ...picks.map((p) => p.userId),
        ].filter(Boolean))
        .catch(() => new Map()),
      getBoxArtUrls(cats.map((c) => c.name)).catch(() => new Map()),
      categoryLinks(channel, cats.map((c) => c.name), req.permission),
    ]);

    // The job already leaves bots out (by id); this second check, by resolved name, also cleans a
    // recap built before it did, and still holds if the job's id lookup failed that night.
    const modTops = {};
    for (const k of ["fastest", "mostActions", "longestGiven", "presence"]) {
      modTops[k] = (mod[k] || []).filter(notBot(profiles)).slice(0, 5);
    }
    const mods = modTops.fastest;

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
      headingEmotes: resolveHeadingEmotes(images),
      nameColor: readableChatColor,
      view: {
        topChatters,
        firstChatters,
        mods,
        modTops,
        siteGames,
        // Box art comes sized for a small chart (144x192); the recap's cards are larger, and Twitch
        // serves the same art at any size from the same template.
        cats: cats.map((c) => ({ ...c, art: (boxArt.get(c.name) || "").replace(/-\d+x\d+\.(jpg|png)$/, "-285x380.$1") || null, href: catLinks.get(c.name) || null })),
        pairs,
        newWords,
        commands: d.commands.slice(0, 8).map((c) => ({ ...c, topUserId: visible(c.topUserId) ? c.topUserId : null })),
        picks: picks.filter((p) => visible(p.userId)),
        moments: (d.loud || []).filter((m) => !hiddenMoments.has(new Date(m.at).toISOString())).slice(0, MOMENTS_SHOWN),
        momentsModerator,
        // Twitch's clip player refuses to load unless told which site embeds it.
        embedParent: req.hostname,
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
      headingEmotes: {},
      nameColor: readableChatColor,
    };
    if (!req.user) return res.render("annualRecapMe", { ...common, needLogin: true });
    if (!personalLimiter(String(req.user.userId))) return res.status(429).send("Too many requests");

    const [personal, optedOut, images, broadcaster, me] = await Promise.all([
      userService.getUserRecap(channel, year, req.user.userId, doc),
      recapRepo.isOptedOut(req.user.userId),
      imagesFor(channel),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      profileCacheRepo.getOrFetchProfile(req.user.userId).catch(() => null),
    ]);

    // Partners are stored by login (that is what an @-mention carries); their ids, for the avatar and
    // chat colour, come from the nickname history.
    const partnerIds = personal.empty ? new Map() : await userService.userIdsByLogin((personal.partners || []).map((p) => p.login));
    const partnerProfiles = await profileCacheRepo.getOrFetchProfiles([...partnerIds.values()]).catch(() => new Map());
    if (!personal.empty) for (const p of personal.partners || []) p.userId = partnerIds.get(p.login) || null;

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
      shareCard: personal.empty ? null : shareCardData({ personal, channel, year, broadcaster, me, images, partnerProfiles, user: req.user }),
      personal,
      quiz,
      optedOut,
      images,
      headingEmotes: resolveHeadingEmotes(images),
      profiles: partnerProfiles,
      messageBuckets: recap.MESSAGE_BUCKETS,
    });
  } catch (err) {
    next(err);
  }
});

// What the shareable picture of a personal recap shows (public/js/recap-share.js draws it). Only
// what the person would show anyone: no punishments, no Bureau, nothing from the private record.
// Picture URLs go through /recap/img so the canvas stays exportable.
function viaProxy(url) {
  return url && isAllowedImageUrl(url) ? `/recap/img?u=${encodeURIComponent(url)}` : null;
}

function shareCardData({ personal: p, channel, year, broadcaster, me, images, partnerProfiles, user }) {
  const emoteUrl = (name) => viaProxy(images.get(name));
  const partner = p.partners[0] || null;
  const partnerProfile = partner && partner.userId ? partnerProfiles.get(String(partner.userId)) : null;
  return {
    year,
    channel: { login: channel.channelLogin, avatar: viaProxy(broadcaster?.avatarUrl) },
    user: {
      name: me?.displayName || user.displayName || p.name,
      avatar: viaProxy(me?.avatarUrl || user.avatarUrl),
      color: readableChatColor(me?.chatColor),
    },
    messages: p.messages,
    rank: p.standing.rank,
    of: p.standing.of,
    streams: { attended: p.attendance.attended, of: p.attendance.of, streak: p.attendance.longestStreak },
    activeDays: p.activeDays,
    peakHourMsk: p.chronotype.peakHour,
    emotes: p.emotes.slice(0, 3).map((e) => ({ name: e.name, n: e.n, url: emoteUrl(e.name) })),
    word: p.words[0] ? { text: p.words[0].word, n: p.words[0].n } : null,
    partner: partner
      ? { name: partnerProfile?.displayName || partner.login, avatar: viaProxy(partnerProfile?.avatarUrl), n: partner.out + partner.in }
      : null,
  };
}

// Same-origin copies of the pictures the share card draws (avatars, emotes). A canvas that drew a
// cross-origin image without CORS cannot be exported, and not every emote CDN sends CORS headers.
// Only hosts the page itself may load pictures from (lib/emoteImageHosts.js), only images, small.
const imgLimiter = createSimpleLimiter({ windowMs: 60 * 1000, max: 120 });
const IMG_MAX_BYTES = 2 * 1024 * 1024;
router.get("/recap/img", async (req, res) => {
  const url = typeof req.query.u === "string" ? req.query.u : "";
  if (!isAllowedImageUrl(url)) return res.status(400).end();
  if (!imgLimiter(req.ip || "?")) return res.status(429).end();
  try {
    const upstream = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      maxContentLength: IMG_MAX_BYTES,
      maxRedirects: 0,
      validateStatus: (st) => st === 200,
    });
    const type = String(upstream.headers["content-type"] || "");
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(type.split(";")[0].trim())) return res.status(415).end();
    res.set("Content-Type", type);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(Buffer.from(upstream.data));
  } catch {
    res.status(502).end();
  }
});

// Remove (or restore) one loud moment. JSON for the page's in-place button, a redirect back to
// the moments for the plain form.
router.post("/:channel/recap/:year/moments/hide", recapWrite, requireLogin, verifyToken, async (req, res, next) => {
  const wantsJson = (req.get("accept") || "").includes("application/json");
  try {
    const { channel } = req;
    const year = parseYear(req.params.year);
    const at = new Date(String(req.body.at || ""));
    if (!year || Number.isNaN(at.getTime())) {
      return wantsJson ? res.status(400).json({ ok: false, error: "invalid" }) : res.status(400).render("errors/400", { backHref: `/${channel.channelLogin}/recap` });
    }
    if (!(await canModerateMoments(req))) {
      return wantsJson ? res.status(403).json({ ok: false, error: "forbidden" }) : res.status(403).render("errors/403", { requiredLevel: 2 });
    }
    const hidden = req.body.hidden !== "0";
    await recapRepo.setMomentHidden(channel.channelLogin, year, at, hidden, req.user.login || req.user.userId);
    if (wantsJson) return res.json({ ok: true, hidden });
    res.redirect(`/${channel.channelLogin}/recap/${year}#moments`);
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
