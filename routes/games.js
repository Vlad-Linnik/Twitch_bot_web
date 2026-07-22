const express = require("express");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const gameCatalogRepo = require("../db/gameCatalogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const gamesCatalog = require("../data/gamesCatalog");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const requireLogin = require("../middleware/requireLogin");

const router = express.Router();

const GAME_FALLING_BLOCKS = "falling-blocks";
const GAME_PIPE_DODGER = "pipe-dodger";
const GAME_2048 = "2048";
const GAME_MINESWEEPER = "minesweeper";
const GAME_MATCH3 = "match-3";
const GAME_CLOUD_CLIMBER = "cloud-climber";
// Battleship/Pong/Connect Four are all rated (Elo, via
// realtime/quickMatchManager.js + realtime/durakElo.js) - same
// "bestScore field holds a live rating" convention as GAME_DURAK_ONLINE.
const GAME_BATTLESHIP = "battleship";
const GAME_PONG = "pong";
const GAME_CONNECT_FOUR = "connect-four";
// Durak's leaderboard ranks online (multiplayer) Elo rating only - a
// vs-computer win never reaches the server at all (see
// public/js/games/durak.js). realtime/durakRoomManager.js's finalizeGame
// computes and persists this key's rating (realtime/durakElo.js) after every
// multiplayer game. New players start at a hidden 300 rating and don't get a
// GameScores doc - so don't appear here - until their first game finishes.
const GAME_DURAK_ONLINE = "durak-multiplayer";
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
//
// Visibility (hide a game entirely) and category grouping are admin/moderator
// controls (/admin/games, db/gameCatalogRepo.js) layered on top of the static
// data/gamesCatalog.js list - a game with no GameSettings doc is visible and
// uncategorized, so this page renders exactly as before until an admin
// actually hides something or creates a category.
router.get("/games", async (req, res, next) => {
  try {
    const [settingsMap, categories] = await Promise.all([
      gameCatalogRepo.getSettingsMap(),
      gameCatalogRepo.listCategories(),
    ]);

    const visible = gamesCatalog.filter((g) => !settingsMap.get(g.id)?.hidden);
    const byCategory = new Map(categories.map((c) => [String(c._id), []]));
    const uncategorized = [];
    visible.forEach((g) => {
      const categoryId = settingsMap.get(g.id)?.categoryId;
      const key = categoryId ? String(categoryId) : null;
      if (key && byCategory.has(key)) byCategory.get(key).push(g);
      else uncategorized.push(g);
    });

    const groups = categories
      .map((c) => ({ category: c, games: byCategory.get(String(c._id)) }))
      .concat([{ category: null, games: uncategorized }])
      .filter((group) => group.games.length > 0);

    res.render("games", { groups });
  } catch (err) {
    next(err);
  }
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

router.get("/games/2048", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_2048, req.user ? req.user.userId : null);
    res.render("game2048", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/minesweeper", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_MINESWEEPER, req.user ? req.user.userId : null);
    res.render("gameMinesweeper", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/match-3", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_MATCH3, req.user ? req.user.userId : null);
    res.render("gameMatch3", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/cloud-climber", async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_CLOUD_CLIMBER, req.user ? req.user.userId : null);
    res.render("gameCloudClimber", { leaderboard });
  } catch (err) {
    next(err);
  }
});

// Battleship, Pong and Connect Four are online-only (auto-matchmaking via
// realtime/quickMatchManager.js) - there's no anonymous/vs-computer mode to
// render, so unlike Durak these are requireLogin-gated at the route, same
// as Durak's own room-deep-link route.
router.get("/games/battleship", requireLogin, async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_BATTLESHIP, req.user.userId);
    res.render("gameBattleship", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/pong", requireLogin, async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_PONG, req.user.userId);
    res.render("gamePong", { leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get("/games/connect-four", requireLogin, async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_CONNECT_FOUR, req.user.userId);
    res.render("gameConnectFour", { leaderboard });
  } catch (err) {
    next(err);
  }
});

// /games/durak is a single page hosting both a vs-computer board and a
// multiplayer lobby/room (public/js/games/durak-mode-select.js toggles
// between them client-side) - open to every visitor, including logged-out
// ones (the "play with people" option just renders as a login link for them,
// see views/gameDurak.ejs). The leaderboard shown here is online-wins-only
// (GAME_DURAK_ONLINE); the vs-computer side never submits a score.
async function renderDurak(req, res, next, autoJoinRoomId) {
  try {
    const leaderboard = await buildLeaderboard(GAME_DURAK_ONLINE, req.user ? req.user.userId : null);
    res.render("gameDurak", { leaderboard, autoJoinRoomId });
  } catch (err) {
    next(err);
  }
}

router.get("/games/durak", (req, res, next) => renderDurak(req, res, next, null));

// A shareable deep link into a specific open multiplayer room - requires
// login (same as joining any room) since there's no point rendering it for a
// visitor who can't join. The client attempts to join this room id once its
// WebSocket connects (unless it auto-resumes into a different room it's
// already seated in).
router.get("/games/durak/room/:roomId", requireLogin, (req, res, next) =>
  renderDurak(req, res, next, req.params.roomId)
);

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
      await gameSessionStatsRepo.recordPlay(GAME_FALLING_BLOCKS);
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
      await gameSessionStatsRepo.recordPlay(GAME_PIPE_DODGER);
      const leaderboard = await buildLeaderboard(GAME_PIPE_DODGER, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// Same shape as falling-blocks'/pipe-dodger's score.json, for public/js/games/2048.js.
router.post(
  "/games/2048/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_2048, req.user.userId, score);
      await gameSessionStatsRepo.recordPlay(GAME_2048);
      const leaderboard = await buildLeaderboard(GAME_2048, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// Same shape as the other three score.json routes, for public/js/games/minesweeper.js.
router.post(
  "/games/minesweeper/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_MINESWEEPER, req.user.userId, score);
      await gameSessionStatsRepo.recordPlay(GAME_MINESWEEPER);
      const leaderboard = await buildLeaderboard(GAME_MINESWEEPER, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// Same shape as the other score.json routes, for public/js/games/match3.js.
router.post(
  "/games/match-3/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_MATCH3, req.user.userId, score);
      await gameSessionStatsRepo.recordPlay(GAME_MATCH3);
      const leaderboard = await buildLeaderboard(GAME_MATCH3, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// Same shape as the other score.json routes, for public/js/games/cloud-climber.js.
router.post(
  "/games/cloud-climber/score.json",
  settingsWriteLimiter,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const score = Number.parseInt(req.body.score, 10);
    if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
      return res.status(400).json({ ok: false, error: "score" });
    }
    try {
      await gameScoresRepo.submitScore(GAME_CLOUD_CLIMBER, req.user.userId, score);
      await gameSessionStatsRepo.recordPlay(GAME_CLOUD_CLIMBER);
      const leaderboard = await buildLeaderboard(GAME_CLOUD_CLIMBER, req.user.userId);
      res.json({ ok: true, ...leaderboard });
    } catch (err) {
      next(err);
    }
  }
);

// No /games/durak/score.json - Durak has no client-callable score endpoint at
// all. Vs-computer wins never leave the browser (localStorage only); online
// wins are credited server-side when a multiplayer game concludes (see
// realtime/durakRoomManager.js's finalizeGame).

module.exports = router;
