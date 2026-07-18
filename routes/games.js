const express = require("express");
const gameScoresRepo = require("../db/gameScoresRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

const GAME_FALLING_BLOCKS = "falling-blocks";
const GAME_PIPE_DODGER = "pipe-dodger";
const TOP_LIMIT = 10;
// Sanity cap on submitted scores. The game itself can't validate a client-run
// score, but a legitimate marathon run stays far below this - anything above is
// a forged request, not a game.
const MAX_SCORE = 2000000;

// Top 10 rows plus (when the visitor is logged in and ranked below them) their
// own row with its real rank - the view renders that as the 11th line. Names
// and chat colors come from the profile cache, same as the stats pages.
async function buildLeaderboard(game, userId) {
  const top = await gameScoresRepo.getTop(game, TOP_LIMIT);
  const me = userId ? await gameScoresRepo.getUserBestAndRank(game, userId) : null;

  const ids = top.map((row) => row.userId);
  if (userId) ids.push(String(userId));
  const profiles = await profileCacheRepo.getOrFetchProfiles(ids);

  const nameOf = (id) => {
    const profile = profiles.get(String(id));
    return {
      displayName: (profile && profile.displayName) || "…",
      color: (profile && profile.chatColor) || null,
    };
  };

  const rows = top.map((row, i) => ({
    rank: i + 1,
    score: row.bestScore,
    isMe: userId != null && row.userId === String(userId),
    ...nameOf(row.userId),
  }));

  let myRow = null;
  if (me && !rows.some((row) => row.isMe)) {
    myRow = { rank: me.rank, score: me.bestScore, ...nameOf(userId) };
  }
  return { rows, myRow };
}

// The on-site games hub. Game logic is fully client-side (public/js/games/*);
// the server's only game state is the per-user best score behind the
// leaderboard (db/gameScoresRepo.js, web-only database). The chat mini-game
// commands (!muteduel, !совет) are listed on the Commands page's "Mini-games"
// category instead, since they're chat commands, not on-site games.
router.get("/games", (req, res) => {
  res.render("games");
});

router.get("/games/falling-blocks", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_FALLING_BLOCKS, req.user ? req.user.userId : null);
    res.render("gameFallingBlocks", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/pipe-dodger", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_PIPE_DODGER, req.user ? req.user.userId : null);
    res.render("gamePipeDodger", { leaderboard });
  } catch (err) {
    next(err);
  }
});

function requireLoginJson(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "auth" });
  next();
}

// Called by the game on game over (public/js/games/falling-blocks.js). Only
// logged-in visitors can save a score - the client doesn't even attempt the
// POST otherwise. Responds with the fresh leaderboard so the page can
// re-render it without a reload.
router.post(
  "/games/falling-blocks/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_FALLING_BLOCKS, req.user.userId, score);
      const leaderboard = await buildLeaderboard(GAME_FALLING_BLOCKS, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// Same shape as falling-blocks' score.json, for public/js/games/pipe-dodger.js.
router.post(
  "/games/pipe-dodger/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_PIPE_DODGER, req.user.userId, score);
      const leaderboard = await buildLeaderboard(GAME_PIPE_DODGER, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
