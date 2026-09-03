// "Выше — ниже" (/games/higher-lower): two chat tokens, the left one's count shown, guess whether
// the right one appeared in more or fewer messages. Right answer - the count counts up, the right
// card slides into the left slot and a new challenger arrives. Wrong answer - the run is over.
//
// The server deals every round and keeps the score, because the answer is the data: the
// challenger's count must not reach the browser before the guess is in. What CAN go early is
// everything else about a card - its word, its picture, its quoted line - so rounds are dealt
// QUEUE_DEPTH ahead and parked in the run document. Answering then reads one document and writes
// one, and the pool, the emote images and the example lookup happen after the answer has already
// been sent. That also means there is
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
const examplesRepo = require("../db/higherLowerExamplesRepo");
const votesRepo = require("../db/higherLowerVotesRepo");
const { buildLeaderboard } = require("../db/gameLeaderboard");
const emoteImages = require("../twitch/emoteImages");
const { pickUsedEmotes } = require("../lib/chatEmotes");
const hl = require("../lib/higherLower");
const { verifyToken } = require("../middleware/csrf");
const { createSimpleLimiter, statsReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// One table per channel AND mode: the two channels' vocabularies are different games, so a streak
// on one says nothing about a streak on the other. Still only for the all-time period - a streak
// set on a rolling month window is scored against data that will not exist next month, so the
// month mode keeps a personal best in the browser instead.
//
// A channel login is [a-z0-9_], so it can never be confused with the mode segment in this key.
// Note the consequence: /admin's per-game score counts (gameScoresRepo.getGameCounts) list one row
// per channel here rather than one for the game.
const scoreKeyFor = (mode, channelLogin) => `higher-lower-${mode}-${channelLogin}`;
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
//
// Fetched in BOTH modes now, because the word mode's quotation is a real chat line and chat lines
// contain emotes: reading one with the names left as bare words ("паровоза возбуждают только
// вагоны Jokerge") is reading something the chat never saw.
//
// But the two uses are NOT interchangeable, and cardFor keeps them apart. This map is "what
// renders as a picture in that chat" (Twitch global + channel + 7TV); a word card is "what
// ChatWordStats counted", and that excludes only what the CHANNEL tracks as an emote. The two
// disagree: measured on #mistercop, 2 of the 6035 words in the pool ("бро", "сис") resolve to an
// image here. Putting a picture on those cards would silently turn a word round into an emote one.
async function imageMapFor(channelLogin) {
  const channel = await channelsRepo.findByLogin(channelLogin);
  if (!channel || !channel.channelId) return new Map();
  return emoteImages.getEmoteImageMap(channel.channelId).catch(() => new Map());
}

// A real chat line for each of the two words on screen. Words only: the ask was for words, and an
// emote card already has its picture. Two indexed lookups by {channel, word}, or an empty map -
// a word with no stored line simply renders without one (jobs/higherLowerExamples.js covers ~99%
// of a pool, not all of it, and covers nothing at all until it has run once).
//
// A line players have voted down is dropped here, on the same curve that thins out a word: a few
// dislikes and it shows up sometimes, enough of them and never again. The word itself keeps
// playing - the objection was to the sentence, not to the word.
async function exampleMapFor(mode, channelLogin, words, scores) {
  if (mode !== "words") return new Map();
  const stored = await examplesRepo.getExamples(channelLogin, words).catch(() => new Map());
  const out = new Map();
  for (const [word, entry] of stored) {
    const net = scores && scores.has(word) ? scores.get(word).exampleNet : 0;
    if (hl.passesVote(net)) out.set(word, entry);
  }
  return out;
}

function cardFor(token, images, examples, votes, { mode, withCount }) {
  const example = examples.get(token.word) || null;
  return {
    label: token.word,
    // Only an emote card carries a picture of itself - see imageMapFor for why the same map cannot
    // decide this for a word card.
    image: mode === "emotes" ? images.get(token.word) || null : null,
    // The quotation carries the emotes it uses, so the client can print it the way chat saw it.
    // Only the ones this line needs - see lib/chatEmotes.js.
    example: example ? { ...example, emotes: pickUsedEmotes([example.text], images) } : null,
    // This player's own thumbs, so the buttons come back lit on a word they have already rated.
    // {word: 1|-1, example: 1|-1}; absent keys mean no vote.
    myVotes: (votes && votes[token.word]) || {},
    ...(withCount ? { count: token.count } : {}),
  };
}

// One dealt-ahead round as it is stored: the count stays on the server, the card beside it is the
// half the browser may have early.
function queueEntry(token, extras) {
  return {
    word: token.word,
    count: token.count,
    card: cardFor(token, extras.images, extras.examples, extras.votes, { mode: extras.mode, withCount: false }),
  };
}

// What the client is allowed to know about the round in progress: the anchor with its number, the
// challenger without one, and the cards behind them - which carry no counts either, and are there
// so the browser can fetch their pictures now rather than while one is sliding into view.
function roundPayload(run, images, examples, votes) {
  return {
    runId: run.runId,
    turn: run.turn,
    score: run.score,
    mode: run.mode,
    period: run.period,
    channel: run.channelLogin,
    left: cardFor(run.anchor, images, examples, votes, { mode: run.mode, withCount: true }),
    right: cardFor(run.challenger, images, examples, votes, { mode: run.mode, withCount: false }),
    upcoming: (run.queue || []).map((e) => e.card).filter(Boolean),
  };
}

// Everything a round needs that depends on which two words came up: pictures, example lines
// (already filtered by their own votes) and this player's thumbs.
async function roundExtras(mode, channelLogin, words, userId) {
  const scores = await higherLowerRepo.getVoteScores(channelLogin).catch(() => new Map());
  const [images, examples, votes] = await Promise.all([
    imageMapFor(channelLogin),
    exampleMapFor(mode, channelLogin, words, scores),
    votesRepo.getUserVotes(channelLogin, userId, words).catch(() => ({})),
  ]);
  // `mode` rides along because cardFor needs it and every call site already holds these extras.
  return { mode, images, examples, votes };
}

// Tops the queue back up to QUEUE_DEPTH. Every caller runs this AFTER its response has gone out
// and without awaiting it: this is the expensive half of a round (a pool that may have to be
// rebuilt, an emote-image map that may have to be refetched from Helix and 7TV, an example
// lookup), and keeping it off the path between the click and the number is the entire point of
// dealing ahead. Failing costs one card of lookahead and nothing else - the answer route draws
// inline when the queue runs dry.
async function refillQueue(run) {
  const queue = Array.isArray(run.queue) ? run.queue : [];
  const missing = hl.QUEUE_DEPTH - queue.length;
  if (missing <= 0) return;

  const [pool, wordVotes, odd] = await Promise.all([
    higherLowerRepo.getPool(run.channelLogin, run.mode, run.period),
    higherLowerRepo.getWordVoteMap(run.channelLogin).catch(() => new Map()),
    higherLowerRepo.getOddPools(run.channelLogin, run.mode, run.period),
  ]);
  // The chain's head: what the next card has to be a legal pair with is the last card dealt, not
  // the one on screen. With an empty queue those are the same token.
  const head = queue.length ? queue[queue.length - 1] : run.challenger;
  const { dealt } = hl.dealAhead(pool, head, run.recent, missing, Math.random, wordVotes, odd);
  // Nothing legal left to deal. Not a failure: the run clears when the queue finally runs out.
  if (!dealt.length) return;

  const extras = await roundExtras(run.mode, run.channelLogin, dealt.map((t) => t.word), run.userId);
  await runsRepo.refill({
    runId: run.runId,
    sessionId: run.sessionId,
    head: head.word,
    entries: dealt.map((t) => queueEntry(t, extras)),
  });
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
    const channels = await playableChannels("words", "all");

    // Tables are per channel now, so the page can only render the one the picker will open on -
    // the largest pool, which is what renderChannels() preselects. Every later switch of channel
    // or mode fetches its table from board.json.
    const board = channels.length
      ? await buildLeaderboard(scoreKeyFor("words", channels[0].channelLogin), userId)
      : { rows: [], myRow: null };

    // Resume: the session remembers the run, so reopening the page lands back on the round in
    // progress instead of costing the player their streak.
    let resume = null;
    if (req.session.hlRunId) {
      const openRun = await runsRepo.findOpen(req.session.hlRunId, req.sessionID);
      if (openRun) {
        // Only the pair on screen needs looking up - the dealt-ahead cards were built when they
        // were dealt and are stored beside their counts.
        const words = [openRun.anchor.word, openRun.challenger.word];
        const extras = await roundExtras(openRun.mode, openRun.channelLogin, words, userId);
        resume = roundPayload(openRun, extras.images, extras.examples, extras.votes);
      } else {
        delete req.session.hlRunId; // finished or expired - stop offering it
      }
    }

    res.render("gameHigherLower", { channels, board, resume });
  } catch (err) {
    next(err);
  }
});

// The table for one channel/mode. Fetched whenever the picker's channel or mode changes, since
// each pairing is its own ladder.
router.get("/games/higher-lower/board.json", statsReadLimiter, async (req, res, next) => {
  try {
    const mode = hl.isMode(req.query.mode) ? req.query.mode : "words";
    const channelLogin = String(req.query.channel || "").toLowerCase().replace(/^#/, "");
    if (!/^[a-z0-9_]{3,25}$/.test(channelLogin)) {
      return res.status(400).json({ ok: false, error: "channel" });
    }
    const userId = req.user ? req.user.userId : null;
    res.json({ ok: true, board: await buildLeaderboard(scoreKeyFor(mode, channelLogin), userId) });
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

    const [pool, wordVotes, odd] = await Promise.all([
      higherLowerRepo.getPool(channelLogin, mode, period),
      higherLowerRepo.getWordVoteMap(channelLogin).catch(() => new Map()),
      higherLowerRepo.getOddPools(channelLogin, mode, period),
    ]);
    const pair = hl.pickOpeningPair(pool, Math.random, wordVotes, odd);
    if (!pair) return res.status(409).json({ ok: false, error: "pool" });

    // The opening pair plus the rounds behind it, drawn as one chain so every neighbour is a legal
    // pair. Doing it here rather than on the first answer means the pool is read once for a run
    // that is about to ask for four cards, and the player is already on a button press that looks
    // like loading.
    const opened = hl.rememberToken(hl.rememberToken([], pair.anchor.word), pair.challenger.word);
    const ahead = hl.dealAhead(pool, pair.challenger, opened, hl.QUEUE_DEPTH, Math.random, wordVotes, odd);

    const userId = req.user ? req.user.userId : null;
    const words = [pair.anchor.word, pair.challenger.word, ...ahead.dealt.map((t) => t.word)];
    const extras = await roundExtras(mode, channelLogin, words, userId);

    const run = await runsRepo.startRun({
      userId,
      sessionId: req.sessionID,
      channelLogin,
      mode,
      period,
      anchor: { word: pair.anchor.word, count: pair.anchor.count },
      challenger: { word: pair.challenger.word, count: pair.challenger.count },
      queue: ahead.dealt.map((t) => queueEntry(t, extras)),
      recent: ahead.recent,
    });

    // Load-bearing beyond resuming: middleware/session.js runs with saveUninitialized:false, so a
    // guest's session is never persisted until something writes to it - and until then every
    // request gets a fresh sessionID, which is the key this run is owned by. Without this write
    // the very next answer would find no run of its own and 409. It is also what the page reads
    // to offer the round back after a reload.
    req.session.hlRunId = run.runId;

    res.json({ ok: true, round: roundPayload(run, extras.images, extras.examples, extras.votes) });
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

    // Correct: the challenger becomes the anchor and the next card comes off the queue, where it
    // has been waiting since it was dealt. Nothing is read and nothing is drawn on this path - one
    // document in, one document out - and the queue is topped up once the answer has gone.
    const queue = Array.isArray(run.queue) ? run.queue : [];
    if (queue.length) {
      const [head, ...rest] = queue;
      const advanced = await runsRepo.advance({
        runId,
        sessionId: req.sessionID,
        turn,
        anchor: { word: run.challenger.word, count: run.challenger.count },
        challenger: { word: head.word, count: head.count },
        queue: rest,
      });
      if (!advanced) return res.status(409).json({ ok: false, error: "turn" });

      res.json({
        ok: true,
        correct: true,
        revealed,
        score: advanced.score,
        turn: advanced.turn,
        next: head.card,
        upcoming: rest.map((e) => e.card).filter(Boolean),
      });
      refillQueue(advanced).catch((err) =>
        console.error("[higher-lower] queue refill failed:", err.message)
      );
      return;
    }

    // Empty queue: a run started before rounds were dealt ahead, or a refill that never landed.
    // Draw inline the way this route always did - a slow answer beats a lost run - and let the
    // refill below stock the queue again for the rounds after it.
    const [pool, wordVotes, odd] = await Promise.all([
      higherLowerRepo.getPool(run.channelLogin, run.mode, run.period),
      higherLowerRepo.getWordVoteMap(run.channelLogin).catch(() => new Map()),
      higherLowerRepo.getOddPools(run.channelLogin, run.mode, run.period),
    ]);
    const recent = hl.rememberToken(run.recent, run.challenger.word);
    const next = hl.pickChallenger(pool, run.challenger, recent, Math.random, wordVotes, odd);

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
      queue: [],
      recent: hl.rememberToken(recent, next.word),
    });
    if (!advanced) return res.status(409).json({ ok: false, error: "turn" });

    const extras = await roundExtras(run.mode, run.channelLogin, [next.word], req.user ? req.user.userId : null);
    res.json({
      ok: true,
      correct: true,
      revealed,
      score: advanced.score,
      turn: advanced.turn,
      next: cardFor({ word: next.word, count: next.count }, extras.images, extras.examples, extras.votes, { mode: run.mode, withCount: false }),
      upcoming: [],
    });
    refillQueue(advanced).catch((err) =>
      console.error("[higher-lower] queue refill failed:", err.message)
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// Rating words and their example lines
// ---------------------------------------------------------------------------------------

// Logged in only, unlike playing. A vote changes the pool for everybody, and a guest is an
// anonymous session anyone can mint again as often as they like - the login is what makes one
// person one vote rather than one browser one vote.
router.post("/games/higher-lower/vote.json", roundLimiter, verifyToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: "login" });

    const channelLogin = String(req.body.channel || "").toLowerCase().replace(/^#/, "");
    const word = String(req.body.word || "");
    const target = req.body.target === "example" ? "example" : "word";
    const value = Number.parseInt(req.body.value, 10);

    if (!/^[a-z0-9_]{3,25}$/.test(channelLogin) || !word || word.length > 40) {
      return res.status(400).json({ ok: false, error: "params" });
    }
    if (value !== 1 && value !== -1) return res.status(400).json({ ok: false, error: "value" });

    const result = await votesRepo.castVote({
      channel: channelLogin,
      word,
      target,
      userId: req.user.userId,
      value,
    });
    res.json({ ok: true, target, value: result.value });
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
    await gameScoresRepo.submitScore(scoreKeyFor(run.mode, run.channelLogin), run.userId, run.score);
  }

  const leaderboard = isRanked
    ? await buildLeaderboard(scoreKeyFor(run.mode, run.channelLogin), req.user ? req.user.userId : null)
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
