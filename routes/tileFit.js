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
    const solvedCount = await tileFitProgressRepo.markSolved(userId, level);
    await gameScoresRepo.submitScore(GAME_KEY, userId, solvedCount);
    await gameSessionStatsRepo.recordPlay(GAME_KEY).catch(() => {});
    const leaderboard = await buildLeaderboard(GAME_KEY, userId);
    res.json({ ok: true, solvedCount, leaderboard });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
