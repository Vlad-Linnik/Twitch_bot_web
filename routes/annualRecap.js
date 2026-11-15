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
const awards = require("../lib/chatAwards");
const awardsRepo = require("../db/chatAwardsRepo");
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
    const [doc, years, picks] = await Promise.all([
      recapRepo.getChannelRecap(channel.channelLogin, year),
      recapRepo.listYears(channel.channelLogin),
      recapRepo.listPicks(channel.channelLogin, year),
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
      awardPhase: awards.phaseOf(year),
      isAdmin: req.permission === 0,
      preview: res.locals.sectionPreview,
      view: {
        topChatters,
        firstChatters,
        mods,
        pairs: d.pairs.filter((p) => visible(p.aId) && visible(p.bId)).slice(0, 6),
        newWords: d.newWords.filter((w) => visible(w.by?.userId)).slice(0, 8),
        commands: d.commands.slice(0, 8).map((c) => ({ ...c, topUserId: visible(c.topUserId) ? c.topUserId : null })),
        askers: d.ai.askers.filter((a) => visible(a.userId)).slice(0, 5),
        picks: picks.filter((p) => visible(p.userId)),
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

// --- «Премия чата» ------------------------------------------------------------------------------
// Rules in lib/chatAwards.js, storage in db/chatAwardsRepo.js.

const voteLimiter = createSimpleLimiter({ windowMs: 10 * 1000, max: 12 });

// The ballot for `year`: null before voting opens, frozen on first need afterwards.
//
// `previewPhase` is the site admin's test view (?preview=soon|open|closed): the page as viewers
// will see it in that phase, today. It must leave nothing behind - freezing a ballot in November
// would fix December's nominees on November's data - so it uses the frozen ballot if one exists
// and otherwise builds one in memory.
async function loadBallot(channel, year, recapDoc, { previewPhase = null } = {}) {
  const phase = previewPhase || awards.phaseOf(year);
  if (phase === "soon") return { phase, ballot: null };
  let stored = await awardsRepo.getBallot(channel.channelLogin, year);
  if (!stored) {
    const d = recapDoc.data;
    const hidden = await recapRepo.optedOutAmong([
      ...d.topChatters.map((u) => u.userId),
      ...d.pairs.flatMap((p) => [p.aId, p.bId]),
      ...d.newWords.map((w) => w.by?.userId),
      ...Object.keys(d.firstChatters),
    ]);
    const openerIds = Object.entries(d.firstChatters)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id);
    const profiles = await profileCacheRepo.getOrFetchProfiles(openerIds).catch(() => new Map());
    const ballot = awards.buildBallot(d, { hidden, nameOf: (id) => profiles.get(String(id))?.login || null });
    if (previewPhase) return { phase, ballot };
    stored = await awardsRepo.freezeBallot(channel.channelLogin, year, ballot);
  }
  return { phase, ballot: stored.ballot };
}

function ballotUserIds(ballot) {
  return (ballot || []).flatMap((a) => a.nominees.flatMap((n) => n.userIds));
}

router.get("/:channel/recap/:year/awards", recapPage, async (req, res, next) => {
  try {
    const { channel } = req;
    const year = parseYear(req.params.year);
    if (!year) return res.status(404).render("errors/404");
    const doc = await recapRepo.getChannelRecap(channel.channelLogin, year);
    if (!doc) return res.status(404).render("errors/404");

    const previewPhase =
      req.permission === 0 && awards.PREVIEW_PHASES.includes(req.query.preview) ? req.query.preview : null;
    const { phase, ballot } = await loadBallot(channel, year, doc, { previewPhase });
    const { start, end } = recap.yearRange(year);
    // The test view is what a viewer would see, so the admin's own identity stays out of it.
    const userId = previewPhase ? null : req.user?.userId || null;

    const [hidden, myVotes, eligible, images, broadcaster, voters] = await Promise.all([
      recapRepo.optedOutAmong(ballotUserIds(ballot)),
      userId && ballot ? awardsRepo.votesOf(channel.channelLogin, year, userId) : {},
      userId && phase === "open"
        ? awardsRepo.hasMessages(channel.channelLogin, userId, start, end, awards.MIN_VOTER_MESSAGES)
        : false,
      imagesFor(channel),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      ballot ? awardsRepo.voterCount(channel.channelLogin, year) : 0,
    ]);

    // Running tallies stay hidden while voting is open - a visible leader pulls votes to itself.
    // The site admin sees them, to notice a ballot being stuffed before it closes. The test view of
    // a finished contest shows made-up votes (lib/chatAwards.js's demoTally), and says so.
    let showResults = ballot && (phase === "closed" || req.permission === 0);
    let tallyRows = [];
    let demo = false;
    if (previewPhase === "closed") {
      tallyRows = awards.demoTally(ballot, `${channel.channelLogin}:${year}`);
      demo = true;
    } else if (previewPhase === "open") {
      showResults = false;
    } else if (showResults) {
      tallyRows = await awardsRepo.tally(channel.channelLogin, year);
    }
    const outcome = showResults ? awards.results(ballot, tallyRows, { hidden }) : null;

    res.render("annualRecapAwards", {
      channel,
      broadcaster,
      channelNav: buildChannelNav(channel, { permission: req.permission, active: "recap" }),
      year,
      preview: res.locals.sectionPreview,
      phase,
      awardWindow: awards.awardsWindow(year),
      ballot: (ballot || []).map((a) => ({
        ...a,
        nominees: a.nominees.filter((n) => n.userIds.every((id) => !hidden.has(String(id)))),
      })),
      results: outcome,
      liveResults: Boolean(showResults) && phase !== "closed",
      myVotes,
      eligible,
      loggedIn: Boolean(userId),
      minMessages: awards.MIN_VOTER_MESSAGES,
      voters: demo ? awards.demoVoterCount(tallyRows) : voters,
      images,
      previewPhase,
      demo,
      isAdmin: req.permission === 0,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/recap/:year/awards/vote", recapWrite, requireLogin, verifyToken, async (req, res, next) => {
  const wantsJson = (req.get("accept") || "").includes("application/json");
  const fail = (status, error) =>
    wantsJson ? res.status(status).json({ ok: false, error }) : res.status(status).render("errors/400", { backHref: req.originalUrl.replace(/\/vote$/, "") });
  try {
    const { channel } = req;
    const year = parseYear(req.params.year);
    if (!year) return fail(404, "not_found");
    if (!voteLimiter(String(req.user.userId))) return fail(429, "rate_limited");
    if (awards.phaseOf(year) !== "open") return fail(409, "closed");

    const doc = await recapRepo.getChannelRecap(channel.channelLogin, year);
    if (!doc) return fail(404, "not_found");
    const { ballot } = await loadBallot(channel, year, doc);

    const key = String(req.body.key || "");
    const nomineeId = String(req.body.nominee || "");
    if (!awards.isValidVote(ballot, key, nomineeId)) return fail(400, "invalid");
    const nominee = ballot.find((a) => a.key === key).nominees.find((n) => n.id === nomineeId);
    const hidden = await recapRepo.optedOutAmong(nominee.userIds);
    if (hidden.size) return fail(400, "invalid");

    const { start, end } = recap.yearRange(year);
    const eligible = await awardsRepo.hasMessages(channel.channelLogin, req.user.userId, start, end, awards.MIN_VOTER_MESSAGES);
    if (!eligible) return fail(403, "not_eligible");

    await awardsRepo.castVote(channel.channelLogin, year, req.user.userId, key, nomineeId);
    if (wantsJson) return res.json({ ok: true, key, nominee: nomineeId });
    res.redirect(`/${channel.channelLogin}/recap/${year}/awards#award-${key}`);
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
