const express = require("express");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const gameCatalogRepo = require("../db/gameCatalogRepo");
const gameRunsRepo = require("../db/gameRunsRepo");
const gameRunFlagsRepo = require("../db/gameRunFlagsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const gamesCatalog = require("../data/gamesCatalog");
const gameReplay = require("../lib/gameReplay");
const replayCodec = require("../public/js/games/engines/replayCodec");
const { verifyToken } = require("../middleware/csrf");
const { gameRunStartLimiter, gameScoreSubmitLimiter } = require("../middleware/rateLimiters");
const requireLogin = require("../middleware/requireLogin");

const router = express.Router();

// Every channel this visitor can open a tier-2 page on: the one they own plus the ones they
// moderate. Read off res.locals.navMenu, which middleware/navMenu.js already computed for this
// request - deliberately NOT a fresh query. Empty for logged-out visitors (that middleware
// returns early without setting navMenu).
function moderatedChannelsFor(res) {
  const menu = res.locals.navMenu;
  if (!menu) return [];
  return [...(menu.ownedChannel ? [menu.ownedChannel] : []), ...(menu.moderatedChannels || [])];
}

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
// Same "bestScore holds a live Elo rating" convention as GAME_DURAK_ONLINE -
// realtime/sunduchkiRoomManager.js's finalizeGame computes and persists it
// after every multiplayer game (durakElo.js's rating math, reused verbatim).
const GAME_SUNDUCHKI_ONLINE = "sunduchki-multiplayer";
const TOP_LIMIT = 10;
// Sanity cap on submitted scores. The game itself can't validate a client-run
// score, but a legitimate marathon run stays far below this - anything above is
// a forged request, not a game.
const MAX_SCORE = 2000000;
// Same idea for cloud-climber's optional deathClimb (px of climb reached in
// the run that scored, not the score itself - see the death-marker feature
// in public/js/games/cloud-climber.js and db/gameScoresRepo.js's submitScore).
const MAX_CLIMB = 2000000;
const DEATH_MARKS_PAGE_SIZE = 20;

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

    // A `requiresModerator` card (currently only the Unban Bureau) is hidden from visitors who
    // moderate no channel - its target is tier-2 gated per channel, so for them it's a card that
    // can only lead to a 403. navMenu already computed both lists for this request
    // (middleware/navMenu.js), so this costs no extra query.
    const canModerateSomething = moderatedChannelsFor(res).length > 0;
    const visible = gamesCatalog.filter(
      (g) => !settingsMap.get(g.id)?.hidden && (!g.requiresModerator || canModerateSomething)
    );
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

// The Unban Bureau's catalog card can't link straight to a page - the real page is per-channel
// (/:channel/unban-bureau, routes/unbanBureau.js). This resolves which channel the visitor means:
// straight through when there's exactly one, a picker when there are several. The per-channel
// route still runs its own requireLevel(2), so this is a convenience, not the access check.
router.get("/unban-bureau", requireLogin, (req, res) => {
  const channels = moderatedChannelsFor(res);
  if (channels.length === 1) {
    return res.redirect(`/${channels[0].channelLogin}/unban-bureau`);
  }
  res.render("unbanBureauPicker", { channels });
});

// The cross-game spectator hub - a single page that drops the viewer into a
// random live match (across every multiplayer game), auto-advances when it
// ends, and lists all live matches in a switch-rooms panel. It embeds the real
// game pages in an iframe (each supports a ?watch=<roomId> spectator mode -
// see the routes below), and its live-match feed is /ws/spectator-hub
// (realtime/spectatorHubManager.js + realtime/liveMatchRegistry.js). Login-
// gated since every spectator WebSocket needs a session anyway.
router.get("/games/watch", requireLogin, (req, res) => {
  res.render("gameWatch");
});

// Present on battleship/pong/connect-four/durak when the page is loaded inside
// the hub's iframe to spectate one specific room. A non-empty ?watch renders
// the page in embed mode (board only, auto-watch, reports match-end to the hub).
function watchRoomParam(req) {
  return typeof req.query.watch === "string" && req.query.watch ? req.query.watch : null;
}

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
    res.render("gameBattleship", { leaderboard, embedWatch: watchRoomParam(req) });
  } catch (err) {
    next(err);
  }
});

router.get("/games/pong", requireLogin, async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_PONG, req.user.userId);
    res.render("gamePong", { leaderboard, embedWatch: watchRoomParam(req) });
  } catch (err) {
    next(err);
  }
});

router.get("/games/connect-four", requireLogin, async (req, res, next) => {
  try {
    const leaderboard = await buildLeaderboard(GAME_CONNECT_FOUR, req.user.userId);
    res.render("gameConnectFour", { leaderboard, embedWatch: watchRoomParam(req) });
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
async function renderDurak(req, res, next, autoJoinRoomId, embedWatch) {
  try {
    const leaderboard = await buildLeaderboard(GAME_DURAK_ONLINE, req.user ? req.user.userId : null);
    res.render("gameDurak", { leaderboard, autoJoinRoomId, embedWatch: embedWatch || null });
  } catch (err) {
    next(err);
  }
}

router.get("/games/durak", (req, res, next) => renderDurak(req, res, next, null, watchRoomParam(req)));

// A shareable deep link into a specific open multiplayer room - requires
// login (same as joining any room) since there's no point rendering it for a
// visitor who can't join. The client attempts to join this room id once its
// WebSocket connects (unless it auto-resumes into a different room it's
// already seated in).
router.get("/games/durak/room/:roomId", requireLogin, (req, res, next) =>
  renderDurak(req, res, next, req.params.roomId)
);

// /games/sunduchki is multiplayer-only (no vs-computer mode, unlike Durak) -
// still open to logged-out visitors, who just see a login prompt in place of
// the create/join lobby (see views/gameSunduchki.ejs).
async function renderSunduchki(req, res, next, autoJoinRoomId, embedWatch) {
  try {
    const leaderboard = await buildLeaderboard(GAME_SUNDUCHKI_ONLINE, req.user ? req.user.userId : null);
    res.render("gameSunduchki", { leaderboard, autoJoinRoomId, embedWatch: embedWatch || null });
  } catch (err) {
    next(err);
  }
}

router.get("/games/sunduchki", (req, res, next) => renderSunduchki(req, res, next, null, watchRoomParam(req)));

router.get("/games/sunduchki/room/:roomId", requireLogin, (req, res, next) =>
  renderSunduchki(req, res, next, req.params.roomId)
);

function requireLoginJson(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "auth" });
  next();
}

// ---------------------------------------------------------------------------
// Solo-game run lifecycle (anti-cheat).
//
// Before this existed, a score submission was a bare integer: log in once,
// read data-csrf out of any game page's HTML, and POST whatever number you
// liked. The session CSRF token is minted once per login and shared with every
// form on the site, so it proves same-origin - never that a game was played.
//
// Now a run has to be STARTED server-side (run/start.json), which issues a
// single-use runId and the RNG seed the game must play with, and the score
// submission carries the input log recorded during that run. lib/gameReplay/
// re-simulates it and computes the score itself. The runId is never rendered
// into a page, so scraping the HTML gets a cheater nothing.
//
// See lib/gameReplay/index.js for the verification policy and the per-game
// driver contract, and db/gameCatalogRepo.js's antiCheat mode for the
// per-game kill switch.
// ---------------------------------------------------------------------------

// Replay logs outrun express.urlencoded's 100kB default on a marathon run, so
// app.js deliberately skips these two paths and they parse their own bodies at
// a higher ceiling. Raising the limit globally would hand every route on the
// box a 384kB attacker-controlled buffer instead of just these two.
const replayBody = express.urlencoded({ extended: false, limit: "384kb" });

// :game arrives from the URL and is used to pick a replay driver module, so it
// must be checked against the fixed solo-game set before going anywhere near a
// require() - see lib/gameReplay/index.js's SOLO_GAMES.
function resolveSoloGame(req, res, next) {
  if (!gameReplay.isSoloGame(req.params.game)) {
    return res.status(404).json({ ok: false, error: "game" });
  }
  next();
}

// Mints a run. Called when the player actually starts playing, not on page
// load - an open run is a claim on wall-clock time, and the plausibility
// checks are only meaningful if the clock starts when the game does.
router.post(
  "/games/:game/run/start.json",
  gameRunStartLimiter,
  resolveSoloGame,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    try {
      const game = req.params.game;
      const driver = gameReplay.getDriver(game);
      const run = await gameRunsRepo.startRun({
        game,
        userId: req.user.userId,
        sessionId: req.sessionID,
        rulesVersion: driver ? driver.rulesVersion : 0,
      });
      res.json({
        ok: true,
        runId: run.runId,
        seed: run.seed,
        rulesVersion: run.rulesVersion,
        serverTime: run.startedAt.getTime(),
      });
    } catch (err) {
      next(err);
    }
  }
);

// Mid-run flush for the two open-ended games. A browser caps a keepalive:true
// fetch body at 64kB, which a marathon input log outgrows - checkpointing
// banks the head of the log so the final submit only carries the tail. Does
// NOT consume the run.
router.post(
  "/games/:game/run/checkpoint.json",
  replayBody,
  gameScoreSubmitLimiter,
  resolveSoloGame,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    try {
      const replay = typeof req.body.replay === "string" ? req.body.replay : "";
      const limits = replayCodec.LIMITS[req.params.game];
      if (!replay || (limits && replay.length > Math.ceil((limits.maxBytes * 4) / 3) + 8)) {
        return res.status(400).json({ ok: false, error: "replay" });
      }
      const saved = await gameRunsRepo.saveCheckpoint({
        runId: String(req.body.runId || ""),
        game: req.params.game,
        userId: req.user.userId,
        replay,
        eventCount: Number.parseInt(req.body.events, 10) || 0,
      });
      if (!saved) return res.status(409).json({ ok: false, error: "run" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// One handler for all six games - these were six byte-identical copies before
// the run lifecycle existed, and keeping them separate would have meant six
// copies of the verification policy too.
router.post(
  "/games/:game/score.json",
  replayBody,
  gameScoreSubmitLimiter,
  resolveSoloGame,
  requireLoginJson,
  verifyToken,
  async (req, res, next) => {
    const game = req.params.game;
    try {
      // Outer sanity bound, unchanged from before: cheap, and rejects a
      // garbage body before any database work happens.
      const claimedScore = Number.parseInt(req.body.score, 10);
      if (!Number.isInteger(claimedScore) || claimedScore < 1 || claimedScore > MAX_SCORE) {
        return res.status(400).json({ ok: false, error: "score" });
      }

      let deathClimb;
      if (req.body.deathClimb !== undefined) {
        const climb = Number.parseInt(req.body.deathClimb, 10);
        if (!Number.isInteger(climb) || climb < 0 || climb > MAX_CLIMB) {
          return res.status(400).json({ ok: false, error: "deathClimb" });
        }
        deathClimb = climb;
      }

      const mode = await gameCatalogRepo.getAntiCheatMode(game);
      if (mode === "off") return finishSubmission(req, res, game, claimedScore, deathClimb);

      const runId = typeof req.body.runId === "string" ? req.body.runId : "";
      const replay = typeof req.body.replay === "string" ? req.body.replay : "";

      // ROLLOUT PHASE A: a client cached before this deployed still posts the
      // old shape. Accept it, subject to the rate ceilings, and flag it - the
      // player did nothing wrong. lib/assetVersion.js fingerprints script
      // URLs, so any page reload already picks up the new client; only
      // long-open tabs land here.
      if (!runId) {
        const verdict = gameReplay.verify({
          game,
          mode,
          run: { runId: null, seed: 0 },
          replayText: "",
          claimedScore,
          deathClimb,
          serverElapsedMs: null,
          legacyClient: true,
        });
        return applyVerdict(req, res, game, verdict, claimedScore, deathClimb, null);
      }

      const replayHash = gameReplay.hashReplay(runId, replay);
      const run = await gameRunsRepo.consumeRun({
        runId,
        game,
        userId: req.user.userId,
        replayHash,
      });

      if (!run) {
        // Idempotency: a submit whose response was lost to a network timeout
        // gets retried with the same runId. That is the SAME request, not a
        // second attempt - answering it with a 409 would cost an honest
        // player the score we already stored.
        const already = await gameRunsRepo.findConsumedRun({
          runId,
          game,
          userId: req.user.userId,
          replayHash,
        });
        if (already) {
          const leaderboard = await buildLeaderboard(game, req.user.userId);
          return res.json({ ok: true, ...leaderboard });
        }
        return res.status(409).json({ ok: false, error: "run" });
      }

      const verdict = gameReplay.verify({
        game,
        mode,
        run,
        replayText: replay,
        claimedScore,
        deathClimb,
        serverElapsedMs: Date.now() - run.startedAt.getTime(),
        // The event index this tail was sliced at - see soloRunClient.js's
        // finish(). Absent on a client cached before that shipped.
        replayFrom: Number.parseInt(req.body.from, 10),
      });
      return applyVerdict(req, res, game, verdict, claimedScore, deathClimb, run);
    } catch (err) {
      next(err);
    }
  }
);

// Stores the verified score and answers with the fresh leaderboard, recording
// a review flag when anything about the run looked off.
//
// A flagged run is HELD, not published: its score stays out of GameScores
// until an admin approves the flag on /admin/game-runs. A flag still never
// costs the player anything by itself - the run is kept intact, with its score
// and its replay, and approving publishes it exactly as submitted - but a
// record nobody has vouched for has no business sitting at the top of a
// leaderboard while it waits for review. The timing heuristics' false-positive
// rate is the reason this is a queue with a human at the end of it rather than
// an outright rejection.
async function applyVerdict(req, res, game, verdict, claimedScore, deathClimb, run) {
  const userId = req.user.userId;
  const previous = await gameScoresRepo.getUserBestAndRank(game, userId);
  const previousBest = previous ? previous.bestScore : null;
  const held = !verdict.reject && verdict.reasons.length > 0;

  if (verdict.reasons.length) {
    await gameRunFlagsRepo.recordFlag({
      runId: run ? run.runId : `legacy:${userId}:${Date.now()}`,
      game,
      userId,
      startedAt: run ? run.startedAt : null,
      serverElapsedMs: run ? Date.now() - run.startedAt.getTime() : null,
      simElapsedMs: verdict.simElapsedMs,
      claimedScore,
      // storedScore is what actually reached the leaderboard, which for a
      // held run is nothing; heldScore is what approving it would publish.
      storedScore: null,
      heldScore: held ? verdict.score : null,
      heldDeathClimb: held && Number.isFinite(deathClimb) ? deathClimb : null,
      previousBest,
      verified: verdict.verified,
      rulesVersion: run ? run.rulesVersion : null,
      reasons: verdict.reasons,
      severity: verdict.severity,
      replayHash: verdict.replayHash,
      replayBytes: verdict.replayBytes,
      replay: typeof req.body.replay === "string" ? req.body.replay : null,
    });
  }

  if (verdict.reject) {
    return res.status(verdict.status || 400).json({ ok: false, error: verdict.error || "replay" });
  }

  if (run) await gameRunsRepo.recordStoredScore(run.runId, held ? null : verdict.score);

  if (held) {
    // The play still counts as a play; only the score is withheld. Answer with
    // the unchanged leaderboard plus a note the client shows the player, so a
    // record that doesn't appear reads as "under review", not as lost.
    await gameSessionStatsRepo.recordPlay(game);
    const leaderboard = await buildLeaderboard(game, userId);
    return res.json({ ok: true, held: true, heldMessage: res.locals.t("games.scoreHeld"), ...leaderboard });
  }
  return finishSubmission(req, res, game, verdict.score, deathClimb);
}

async function finishSubmission(req, res, game, score, deathClimb) {
  await gameScoresRepo.submitScore(game, req.user.userId, score, deathClimb);
  await gameSessionStatsRepo.recordPlay(game);
  const leaderboard = await buildLeaderboard(game, req.user.userId);
  res.json({ ok: true, ...leaderboard });
}

// Paginated "other players' death marks" for cloud-climber.js's death-marker
// feature - up to DEATH_MARKS_PAGE_SIZE (20) per call, sorted by climb
// ascending and strictly after ?after=, so the client can page through
// however many players have died as its own climb approaches the
// last-loaded batch instead of fetching every mark up front. Public (no
// login required to view), same as the page itself; a logged-in visitor's
// own row is excluded since their own deaths are already shown from their
// browser's local marks.
router.get("/games/cloud-climber/death-marks.json", async (req, res, next) => {
  try {
    const afterRaw = Number.parseInt(req.query.after, 10);
    const after = Number.isFinite(afterRaw) ? afterRaw : -1;
    const excludeUserId = req.user ? req.user.userId : null;
    const docs = await gameScoresRepo.getDeathMarksPage(GAME_CLOUD_CLIMBER, after, DEATH_MARKS_PAGE_SIZE, excludeUserId);
    const profiles = await profileCacheRepo.getOrFetchProfiles(docs.map((d) => d.userId));
    const marks = docs.map((d) => {
      const profile = profiles.get(String(d.userId));
      return { name: (profile && profile.displayName) || "…", climb: d.deathClimb };
    });
    res.json({ ok: true, marks });
  } catch (err) {
    next(err);
  }
});

// No /games/durak/score.json - Durak has no client-callable score endpoint at
// all. Vs-computer wins never leave the browser (localStorage only); online
// wins are credited server-side when a multiplayer game concludes (see
// realtime/durakRoomManager.js's finalizeGame).

module.exports = router;
