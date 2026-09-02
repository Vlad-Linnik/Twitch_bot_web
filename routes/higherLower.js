// "Выше — ниже" (/games/higher-lower): two chat tokens, the left one's count shown, guess whether
// the right one appeared in more or fewer messages. Right answer - the count counts up, the right
// card slides into the left slot and a new challenger arrives. Wrong answer - the run is over.
//
// The server deals every round and keeps the score, because the answer is the data: the
// challenger's count must not reach the browser before the guess is in. That also means there is
// no client submission and no lib/gameReplay verification here - nothing about the score was ever
// the client's to claim. What it does NOT defend against is the same counts being published, top
// 100 at a time, on /<channel>/statistics/chat: this leaderboard is a soft one by construction,
// and the game is presented as trivia rather than as a contest.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const higherLowerRepo = require("../db/higherLowerRepo");
const runsRepo = require("../db/higherLowerRunsRepo");
const { buildLeaderboard } = require("../db/gameLeaderboard");
const emoteImages = require("../twitch/emoteImages");
const hl = require("../lib/higherLower");
const { verifyToken } = require("../middleware/csrf");
const { createSimpleLimiter, statsReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// The leaderboard exists only for the all-time period - a streak set on a month window is scored
// against data that will not exist next month, so there is nothing to compare it with. The month
// mode keeps a personal best in the browser instead.
const scoreKeyFor = (mode) => `higher-lower-${mode}`;
const CATALOG_ID = "higher-lower";

// A round is one small request; a run is a few dozen of them. Generous enough that fast play
// never trips it, tight enough that a script cannot walk the pool for free. createSimpleLimiter
// hands back a bare allow(key) predicate (the same shape realtime/quickMatchManager.js uses), so
// the express wrapper lives here - and it keys on the session, not the user, because guests play.
const allowRound = createSimpleLimiter({ windowMs: 60 * 1000, max: 120 });

function roundLimiter(req, res, next) {
  if (!allowRound(req.sessionID)) return res.status(429).json({ ok: false, error: "rate" });
  next();
}

// Guests play (nothing they do reaches a leaderboard), and middleware/csrf.js issues a token only
// to logged-in visitors on purpose - so requiring one unconditionally would lock out exactly the
// people the token protects nothing for. The check applies to everyone who has an account to
// protect, and a guest's forgeable request can at most start or lose a run in their own session.
function verifyIfAuthed(req, res, next) {
  if (!req.user) return next();
  return verifyToken(req, res, next);
}

// ---------------------------------------------------------------------------------------
// Round payloads
// ---------------------------------------------------------------------------------------

// Emote name -> image URL for one channel, or an empty map. Fail-soft on purpose: emoteImages.js
// reaches out to Helix and 7TV, and an unreachable one must cost a picture, not the game. An
// emote that has since left the channel's set has no image at all and is rendered as its name -
// its usage row is still in the stats and it is a legitimate thing to be asked about.
async function imageMapFor(mode, channelLogin) {
  if (mode !== "emotes") return new Map();
  const channel = await channelsRepo.findByLogin(channelLogin);
  if (!channel || !channel.channelId) return new Map();
  return emoteImages.getEmoteImageMap(channel.channelId).catch(() => new Map());
}

function cardFor(token, images, { withCount }) {
  return {
    label: token.word,
    image: images.get(token.word) || null,
    ...(withCount ? { count: token.count } : {}),
  };
}

// What the client is allowed to know about the round in progress: the anchor with its number, the
// challenger without one.
function roundPayload(run, images) {
  return {
    runId: run.runId,
    turn: run.turn,
    score: run.score,
    mode: run.mode,
    period: run.period,
    channel: run.channelLogin,
    left: cardFor(run.anchor, images, { withCount: true }),
    right: cardFor(run.challenger, images, { withCount: false }),
  };
}

// ---------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------

async function playableChannels(mode, period) {
  const channels = await channelsRepo.listEnabled();
  return higherLowerRepo.listPlayableChannels(channels, mode, period);
}

router.get("/games/higher-lower", async (req, res, next) => {
  try {
    const userId = req.user ? req.user.userId : null;
    const [channels, wordsBoard, emotesBoard] = await Promise.all([
      playableChannels("words", "all"),
      buildLeaderboard(scoreKeyFor("words"), userId),
      buildLeaderboard(scoreKeyFor("emotes"), userId),
    ]);

    // Resume: the session remembers the run, so reopening the page lands back on the round in
    // progress instead of costing the player their streak.
    let resume = null;
    if (req.session.hlRunId) {
      const openRun = await runsRepo.findOpen(req.session.hlRunId, req.sessionID);
      if (openRun) {
        const images = await imageMapFor(openRun.mode, openRun.channelLogin);
        resume = roundPayload(openRun, images);
      } else {
        delete req.session.hlRunId; // finished or expired - stop offering it
      }
    }

    res.render("gameHigherLower", {
      channels,
      leaderboards: { words: wordsBoard, emotes: emotesBoard },
      resume,
    });
  } catch (err) {
    next(err);
  }
});

// Channel list for a mode/period the visitor switched to on the start screen. Cheap for the
// all-time periods (index counts) and cached for the month ones, which cost an aggregation.
router.get("/games/higher-lower/channels.json", statsReadLimiter, async (req, res, next) => {
  try {
    const mode = hl.isMode(req.query.mode) ? req.query.mode : "words";
    const period = hl.isPeriod(req.query.period) ? req.query.period : "all";
    res.json({ ok: true, mode, period, channels: await playableChannels(mode, period) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------------------

router.post("/games/higher-lower/start.json", roundLimiter, verifyIfAuthed, async (req, res, next) => {
  try {
    const mode = hl.isMode(req.body.mode) ? req.body.mode : null;
    const period = hl.isPeriod(req.body.period) ? req.body.period : null;
    const channelLogin = String(req.body.channel || "").toLowerCase().replace(/^#/, "");
    if (!mode || !period || !/^[a-z0-9_]{3,25}$/.test(channelLogin)) {
      return res.status(400).json({ ok: false, error: "params" });
    }

    // The channel has to be one the picker would have offered - both because a thin pool makes an
    // unplayable game and because this is what stops a crafted request from aiming the game at a
    // channel the bot does not serve.
    const offered = await playableChannels(mode, period);
    if (!offered.some((c) => c.channelLogin === channelLogin)) {
      return res.status(400).json({ ok: false, error: "channel" });
    }

    const pool = await higherLowerRepo.getPool(channelLogin, mode, period);
    const pair = hl.pickOpeningPair(pool);
    if (!pair) return res.status(409).json({ ok: false, error: "pool" });

    const run = await runsRepo.startRun({
      userId: req.user ? req.user.userId : null,
      sessionId: req.sessionID,
      channelLogin,
      mode,
      period,
      anchor: { word: pair.anchor.word, count: pair.anchor.count },
      challenger: { word: pair.challenger.word, count: pair.challenger.count },
    });

    // Load-bearing beyond resuming: middleware/session.js runs with saveUninitialized:false, so a
    // guest's session is never persisted until something writes to it - and until then every
    // request gets a fresh sessionID, which is the key this run is owned by. Without this write
    // the very next answer would find no run of its own and 409. It is also what the page reads
    // to offer the round back after a reload.
    req.session.hlRunId = run.runId;

    const images = await imageMapFor(mode, channelLogin);
    res.json({ ok: true, round: roundPayload(run, images) });
  } catch (err) {
    next(err);
  }
});

router.post("/games/higher-lower/answer.json", roundLimiter, verifyIfAuthed, async (req, res, next) => {
  try {
    const runId = String(req.body.runId || "");
    const turn = Number.parseInt(req.body.turn, 10);
    const guess = req.body.guess === "higher" || req.body.guess === "lower" ? req.body.guess : null;
    if (!runId || !Number.isInteger(turn) || turn < 0 || !guess) {
      return res.status(400).json({ ok: false, error: "params" });
    }

    const run = await runsRepo.findOpen(runId, req.sessionID);
    if (!run) return res.status(409).json({ ok: false, error: "run" });
    // A stale turn is a double-click or a retry, not a second answer. The atomic filters in
    // advance()/finish() enforce this too; failing here first keeps the wasted work to a read.
    if (run.turn !== turn) return res.status(409).json({ ok: false, error: "turn" });

    const revealed = run.challenger.count;
    const correct = hl.isCorrect(run.anchor.count, revealed, guess);

    if (!correct) {
      const finished = await runsRepo.finish({ runId, sessionId: req.sessionID, turn, outcome: "lost" });
      if (!finished) return res.status(409).json({ ok: false, error: "turn" });
      return res.json({ ok: true, ...(await gameOver(req, finished, revealed)) });
    }

    // Correct: the challenger becomes the anchor and a new one is drawn. The pool is re-read
    // rather than carried in the run document - it is cached in process for half an hour, and the
    // rows behind an all-time word pool are 7.5k of them.
    const pool = await higherLowerRepo.getPool(run.channelLogin, run.mode, run.period);
    const recent = hl.rememberToken(run.recent, run.challenger.word);
    const next = hl.pickChallenger(pool, run.challenger, recent, Math.random);

    if (!next) {
      // No legal opponent left for this anchor. That is a cleared run, not a loss - the last
      // answer was right and there is nothing left to ask, so it is scored (bumpScore) and the
      // end screen says cleared rather than lost.
      const finished = await runsRepo.finish({
        runId,
        sessionId: req.sessionID,
        turn,
        outcome: "cleared",
        bumpScore: true,
      });
      if (!finished) return res.status(409).json({ ok: false, error: "turn" });
      const over = await gameOver(req, finished, revealed);
      return res.json({ ok: true, ...over, correct: true, cleared: true });
    }

    const advanced = await runsRepo.advance({
      runId,
      sessionId: req.sessionID,
      turn,
      anchor: { word: run.challenger.word, count: run.challenger.count },
      challenger: { word: next.word, count: next.count },
      recent: hl.rememberToken(recent, next.word),
    });
    if (!advanced) return res.status(409).json({ ok: false, error: "turn" });

    const images = await imageMapFor(run.mode, run.channelLogin);
    res.json({
      ok: true,
      correct: true,
      revealed,
      score: advanced.score,
      turn: advanced.turn,
      next: cardFor({ word: next.word, count: next.count }, images, { withCount: false }),
    });
  } catch (err) {
    next(err);
  }
});

// Everything the end-of-run screen needs. The score is written here, by the server that counted
// it - there is no submit endpoint for a client to call.
async function gameOver(req, run, revealed) {
  const isRanked = run.period === "all";
  delete req.session.hlRunId; // the run is closed; the page must stop offering to resume it
  await gameSessionStatsRepo.recordPlay(CATALOG_ID).catch(() => {});

  if (run.userId && isRanked && run.score > 0) {
    await gameScoresRepo.submitScore(scoreKeyFor(run.mode), run.userId, run.score);
  }

  const leaderboard = isRanked
    ? await buildLeaderboard(scoreKeyFor(run.mode), req.user ? req.user.userId : null)
    : null;

  return {
    correct: false,
    revealed,
    finished: true,
    score: run.score,
    ranked: isRanked,
    leaderboard,
  };
}

module.exports = router;
