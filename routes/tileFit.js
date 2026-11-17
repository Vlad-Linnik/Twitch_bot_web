// "Укладка" (/games/tile-fit): a hundred packing puzzles - drag every piece onto the board so it is
// covered exactly. No timer and no score beyond "how many levels are solved".
//
// The levels are generated from their number by public/js/games/engines/tileFitEngine.js, which
// this route loads too. That is the whole anti-cheat: a solve is a placement of every piece, and
// the server rebuilds the level and checks the placement covers it before counting it. There is
// nothing to replay and no score to trust - a level is either covered or it is not.
//
// Guests play every level; their progress stays in the browser. Only a logged-in solve reaches
// the leaderboard.
const express = require("express");
const engine = require("../public/js/games/engines/tileFitEngine");
const tileFitProgressRepo = require("../db/tileFitProgressRepo");
const tileFitDailyRepo = require("../db/tileFitDailyRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const days = require("../lib/tileFitDays");
const sharp = require("sharp");
const channelsRepo = require("../db/channelsRepo");
const emoteImages = require("../twitch/emoteImages");
const emoteBoardsRepo = require("../db/tileFitEmoteBoardsRepo");
const { boardFromPixels, SIDE } = require("../lib/tileFitEmoteBoard");
const { isAllowedImageUrl } = require("../lib/emoteImageHosts");
const { statsReadLimiter } = require("../middleware/rateLimiters");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const { buildLeaderboard } = require("../db/gameLeaderboard");
const { verifyToken } = require("../middleware/csrf");
const { gameScoreSubmitLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

const GAME_KEY = "tile-fit";

router.get("/games/tile-fit", async (req, res, next) => {
  try {
    const userId = req.user ? req.user.userId : null;
    const [leaderboard, solved] = await Promise.all([
      buildLeaderboard(GAME_KEY, userId),
      userId ? tileFitProgressRepo.getSolved(userId) : Promise.resolve([]),
    ]);
    res.render("gameTileFit", {
      leaderboard,
      solved,
      levelsVersion: engine.LEVELS_VERSION,
    });
  } catch (err) {
    next(err);
  }
});

function parsePlacements(raw) {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 40) return null;
  return parsed.map((p) =>
    p && typeof p === "object" ? { rot: Number(p.rot), r: Number(p.r), c: Number(p.c) } : null
  );
}

router.post("/games/tile-fit/solve.json", gameScoreSubmitLimiter, async (req, res, next) => {
  if (!req.user) return res.status(401).json({ ok: false, error: "auth" });
  next();
}, verifyToken, async (req, res, next) => {
  try {
    const level = Number.parseInt(req.body.level, 10);
    const levelData = engine.generateLevel(level);
    if (!levelData) return res.status(400).json({ ok: false, error: "level" });
    // A board cut by an older generator is a different puzzle under the same number.
    if (Number.parseInt(req.body.version, 10) !== engine.LEVELS_VERSION) {
      return res.status(409).json({ ok: false, error: "version" });
    }
    const placements = parsePlacements(req.body.placements);
    const problem = engine.checkSolution(levelData, placements);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    const userId = req.user.userId;
    // The level of the day has its own table, ranked by moves, and does not count as a level.
    if (engine.isDaily(level)) {
      if (!days.isAroundToday(level, new Date())) return res.status(400).json({ ok: false, error: "day" });
      const moves = Math.max(levelData.pieces.length, Math.min(999, Number.parseInt(req.body.moves, 10) || 999));
      await tileFitDailyRepo.record(level, userId, moves);
      const [board, streak] = await Promise.all([dailyBoard(level, userId), tileFitDailyRepo.streak(userId, level, days.previousDay)]);
      return res.json({ ok: true, daily: { ...board, streak } });
    }
    const solvedCount = await tileFitProgressRepo.markSolved(userId, level);
    await gameScoresRepo.submitScore(GAME_KEY, userId, solvedCount);
    await gameSessionStatsRepo.recordPlay(GAME_KEY).catch(() => {});
    const leaderboard = await buildLeaderboard(GAME_KEY, userId);
    res.json({ ok: true, solvedCount, leaderboard });
  } catch (err) {
    next(err);
  }
});

// The table of one day: the ten fewest-moves solves, and the viewer's own place.
async function dailyBoard(day, userId) {
  const [rows, me] = await Promise.all([tileFitDailyRepo.top(day, 10), userId ? tileFitDailyRepo.mine(day, userId) : null]);
  const profiles = await profileCacheRepo.getOrFetchProfiles([...rows.map((r) => r.userId), ...(userId ? [String(userId)] : [])]);
  const nameOf = (id) => (profiles.get(String(id)) || {}).displayName || "…";
  return {
    rows: rows.map((r, i) => ({ rank: i + 1, moves: r.moves, displayName: nameOf(r.userId), isMe: userId != null && r.userId === String(userId) })),
    me: me ? { ...me, displayName: nameOf(userId) } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Emote boards: a hand-picked set of emotes, each turned into a board to assemble. Built on
// demand and kept for a week (db/tileFitEmoteBoardsRepo.js). Only the picture is fetched, and only
// from an emote CDN the site already allows (lib/emoteImageHosts.js) - the URL never comes from
// the request.
// ---------------------------------------------------------------------------------------------
const EMOTE_FETCH_TIMEOUT_MS = 6000;
const EMOTE_MAX_BYTES = 2 * 1024 * 1024;

async function buildEmoteBoard(url) {
  if (!isAllowedImageUrl(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(EMOTE_FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > EMOTE_MAX_BYTES) return null;
  // The first frame of an animated emote, shrunk to fit the 10 x 10 board, transparent around it.
  const { data, info } = await sharp(buf, { animated: false })
    .resize(SIDE, SIDE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return boardFromPixels(data, info.width, info.height);
}

// The set: one viewer's favourite emotes in one channel. Names are matched case-insensitively
// against that channel's emote pictures, so the list keeps working whichever provider (Twitch,
// 7TV, BTTV, FFZ) an emote comes from.
const FEATURED_EMOTES = {
  channel: "mistercop",
  emotes: ["MickeyMouse", "Jokerge", "D:", "cannyCat", "BloodTrail"],
};

router.get("/games/tile-fit/emotes.json", statsReadLimiter, async (req, res, next) => {
  try {
    const login = FEATURED_EMOTES.channel;
    const channel = await channelsRepo.findByLogin(login);
    if (!channel) return res.status(404).json({ ok: false, error: "channel" });
    let images = await emoteImages.getEmoteImageMap(String(channel.channelId), login);
    // A channel's 7TV set is one large response and the first request after a restart can come
    // back empty; the list names emotes that exist, so a shortfall is worth one retry.
    const has = (map) => new Set([...map.keys()].map((k) => k.toLowerCase()));
    if (FEATURED_EMOTES.emotes.some((e) => !has(images).has(e.toLowerCase()))) {
      images = await emoteImages.getEmoteImageMap(String(channel.channelId), login);
    }
    // The picture map is keyed by each emote's canonical spelling.
    const byLower = new Map([...images.keys()].map((k) => [k.toLowerCase(), k]));
    const candidates = FEATURED_EMOTES.emotes.map((e) => byLower.get(e.toLowerCase())).filter(Boolean);
    const cached = await emoteBoardsRepo.getFresh(login, candidates);
    const boards = [];
    for (const emote of candidates) {
      let doc = cached.get(emote);
      if (!doc) {
        let board = null;
        try {
          board = await buildEmoteBoard(images.get(emote));
        } catch (err) {
          console.error("[tile-fit] emote board failed:", emote, err.message);
          continue; // a network hiccup is not a verdict on the emote - try again next time
        }
        await emoteBoardsRepo.save(login, emote, board);
        doc = board ? { ...board, empty: false } : { empty: true };
      }
      if (!doc.empty) boards.push({ emote, image: images.get(emote), mask: doc.mask, colors: doc.colors });
    }
    res.json({ ok: true, channel: login, boards });
  } catch (err) {
    next(err);
  }
});

router.get("/games/tile-fit/daily.json", async (req, res, next) => {
  try {
    const day = Number.parseInt(req.query.day, 10);
    if (!engine.isDaily(day)) return res.status(400).json({ ok: false, error: "day" });
    const userId = req.user ? req.user.userId : null;
    const [board, streak] = await Promise.all([
      dailyBoard(day, userId),
      userId ? tileFitDailyRepo.streak(userId, day, days.previousDay) : Promise.resolve(0),
    ]);
    res.json({ ok: true, ...board, streak });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
