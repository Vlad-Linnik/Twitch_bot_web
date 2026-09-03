// "Угадай чатера" (/games/guess-chatter): one real chat line, four logins, pick its author.
//
// The whole run - questions, hints, and the right answers - is handed to the browser in a single
// request, and the browser grades it. That is not an oversight: this game has no leaderboard, so
// there is nothing a hidden answer would protect. What the alternative would cost is concrete - a
// run collection, a per-round endpoint, resume logic and a rate limiter around all of it (see
// routes/higherLower.js, where the count IS the answer and the server has no choice). Someone who
// opens devtools spoils their own game and nobody else's.
const express = require("express");
const { ObjectId } = require("mongodb");
const channelsRepo = require("../db/channelsRepo");
const questionsRepo = require("../db/guessChatterRepo");
const votesRepo = require("../db/guessChatterVotesRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const { getDisplayProfile } = require("../db/userProfileService");
const emoteImages = require("../twitch/emoteImages");
const { pickUsedEmotes } = require("../lib/chatEmotes");
const gc = require("../lib/guessChatter");
const { verifyToken } = require("../middleware/csrf");
const { createSimpleLimiter, statsReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();
const CATALOG_ID = "guess-chatter";

// A run is one request and a context lookup is one click, so this only has to stop a script from
// walking the pool. Keyed on the session rather than the user, because guests play.
const allowRun = createSimpleLimiter({ windowMs: 60 * 1000, max: 40 });

function runLimiter(req, res, next) {
  if (!allowRun(req.sessionID)) return res.status(429).json({ ok: false, error: "rate" });
  next();
}

// Its own bucket rather than a share of the one above: a run puts ten questions and thirty hints
// on screen, so a player working through a run and rating as they go would otherwise spend the
// budget that starting the next one needs. Keyed on the user, because voting is logged-in only.
const allowVote = createSimpleLimiter({ windowMs: 60 * 1000, max: 60 });

function voteLimiter(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "login" });
  if (!allowVote(String(req.user.userId))) return res.status(429).json({ ok: false, error: "rate" });
  next();
}

// Guests play, and middleware/csrf.js issues a token only to logged-in visitors - so requiring one
// unconditionally would lock out exactly the people it protects nothing for. Same shape as
// routes/higherLower.js.
function verifyIfAuthed(req, res, next) {
  if (!req.user) return next();
  return verifyToken(req, res, next);
}

const cleanLogin = (value) => String(value || "").toLowerCase().replace(/^#/, "");
const isLogin = (value) => /^[a-z0-9_]{3,25}$/.test(value);

async function playableChannels() {
  const channels = await channelsRepo.listEnabled();
  return questionsRepo.listPlayableChannels(channels);
}

// ---------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------

router.get("/games/guess-chatter", async (req, res, next) => {
  try {
    res.render("gameGuessChatter", { channels: await playableChannels(), rounds: gc.ROUNDS });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------------------

// Faces for everyone who appears as an option anywhere in the run, fetched once. getDisplayProfile
// fails soft on its own, so an unreachable Twitch costs a picture rather than the game.
async function profileMap(userIds) {
  const unique = [...new Set(userIds)];
  const rows = await Promise.all(unique.map((id) => getDisplayProfile(id)));
  return new Map(rows.map((r) => [r.userId, r]));
}

// The channel's emote pictures, or an empty map. Fail-soft on purpose, the same call
// routes/higherLower.js makes: emoteImages.js reaches out to Helix and 7TV, and an unreachable one
// must cost a picture rather than the game - an emote with no image renders as its name, which is
// exactly what the chat line said.
async function emoteMapFor(channelLogin) {
  const channel = await channelsRepo.findByLogin(channelLogin).catch(() => null);
  if (!channel || !channel.channelId) return new Map();
  return emoteImages.getEmoteImageMap(channel.channelId, channelLogin).catch(() => new Map());
}

router.post("/games/guess-chatter/start.json", runLimiter, verifyIfAuthed, async (req, res, next) => {
  try {
    const channelLogin = cleanLogin(req.body.channel);
    if (!isLogin(channelLogin)) return res.status(400).json({ ok: false, error: "params" });

    // The channel has to be one the picker would have offered - both because a thin pool makes an
    // unplayable game and because this is what stops a crafted request aiming the game at a
    // channel the bot does not serve.
    const offered = await playableChannels();
    if (!offered.some((c) => c.channelLogin === channelLogin)) {
      return res.status(400).json({ ok: false, error: "channel" });
    }

    const pool = await questionsRepo.getAuthors(channelLogin);
    if (!gc.isChannelPlayable(pool.length)) return res.status(409).json({ ok: false, error: "pool" });

    const poolIds = pool.map((p) => p.userId);
    // The ratings are read before the draw and used twice, on the two roles separately: a line
    // players rejected as a question keeps its ordinary chance of turning up as a hint, and the
    // other way round. Fail-soft - an unreachable scores collection deals the pool unweighted,
    // which is what the game did before anyone could vote.
    const [drawn, scores] = await Promise.all([
      questionsRepo.drawQuestions(channelLogin, poolIds),
      questionsRepo.getVoteScores(channelLogin).catch(() => new Map()),
    ]);
    const candidates = gc.pickRunQuestions(
      drawn.strict,
      drawn.loose,
      Math.random,
      gc.voteLookup(scores, "question")
    );

    // A question whose @-mentions leave too few legal decoys is dropped rather than asked with
    // three options - drawQuestions() over-draws for exactly this.
    const rounds = [];
    for (const q of candidates) {
      if (rounds.length >= gc.ROUNDS) break;
      const options = gc.pickOptions(pool, q.userId, q.text);
      if (options) rounds.push({ question: q, options });
    }
    if (rounds.length === 0) return res.status(409).json({ ok: false, error: "pool" });

    // Hints are drawn per author so that a question about a quiet author still gets three of their
    // own lines. Over-drawn by HINT_SPARE: the question itself may come back in the sample, and so
    // may lines this channel has thumbed down as hints.
    const hintLines = await Promise.all(
      rounds.map((r) =>
        questionsRepo
          .drawAuthorLines(channelLogin, r.question.userId, gc.HINTS + gc.HINT_SPARE)
          .catch(() => [])
      )
    );

    const hintNet = gc.voteLookup(scores, "hint");
    const hints = rounds.map((r, i) =>
      gc.pickHints(hintLines[i], r.question._id, Math.random, hintNet).map((h) => ({
        // The key, not the _id: it is what a thumb is filed under, and it survives the weekly
        // rebuild that gives the same line a new document. See db/guessChatterVotesRepo.js.
        key: h.key,
        text: h.text,
      }))
    );

    // Every line this run puts on screen, in either role, so the player's own thumbs come back lit
    // in one lookup rather than one per round.
    const keys = [...new Set([...rounds.map((r) => r.question.key), ...hints.flat().map((h) => h.key)])];
    const [profiles, emoteMap, myVotes] = await Promise.all([
      profileMap(rounds.flatMap((r) => r.options.map((o) => o.userId))),
      emoteMapFor(channelLogin),
      votesRepo.getUserVotes(channelLogin, req.user ? req.user.userId : null, keys).catch(() => ({})),
    ]);

    res.json({
      ok: true,
      channel: channelLogin,
      // Only the emotes these lines actually use, not the channel's whole set - see
      // lib/chatEmotes.js. The client swaps names for pictures; a name with no picture here stays
      // text, which is what the message said anyway.
      emotes: pickUsedEmotes(
        [...rounds.map((r) => r.question.text), ...hints.flat().map((h) => h.text)],
        emoteMap
      ),
      // This player's own thumbs, keyed by line: {key: {question: 1|-1, hint: 1|-1}}. Sent once for
      // the whole run rather than per card, because the same line can be the question in one round
      // and a hint in another, and the two buttons have to agree.
      myVotes,
      rounds: rounds.map((r, i) => ({
        id: String(r.question._id),
        key: r.question.key,
        text: r.question.text,
        at: r.question.ts,
        admixed: !!r.question.admixed,
        answerId: r.question.userId,
        hints: hints[i],
        options: r.options.map((o) => {
          const p = profiles.get(o.userId);
          return {
            userId: o.userId,
            login: o.login,
            avatarUrl: p ? p.avatarUrl : null,
            color: p ? p.color : null,
          };
        }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// Rating a line
// ---------------------------------------------------------------------------------------

// Logged in only, unlike playing. A vote changes what everybody is dealt, and a guest is an
// anonymous session anyone can mint again as often as they like - the login is what makes one
// person one vote rather than one browser one vote. Same rule, and the same reason, as
// routes/higherLower.js.
router.post("/games/guess-chatter/vote.json", voteLimiter, verifyToken, async (req, res, next) => {
  try {
    const channelLogin = cleanLogin(req.body.channel);
    const key = String(req.body.key || "");
    const target = req.body.target === "hint" ? "hint" : "question";
    const value = Number.parseInt(req.body.value, 10);

    // The key is questionKey() output, so it is bounded by MAX_LENGTH - anything longer never came
    // from a card this game dealt.
    if (!isLogin(channelLogin) || !key || key.length > gc.MAX_LENGTH) {
      return res.status(400).json({ ok: false, error: "params" });
    }
    if (value !== 1 && value !== -1) return res.status(400).json({ ok: false, error: "value" });

    const result = await votesRepo.castVote({
      channel: channelLogin,
      key,
      target,
      userId: req.user.userId,
      value,
    });
    res.json({ ok: true, target, value: result.value });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------
// The context view
// ---------------------------------------------------------------------------------------

// Fetched on click rather than shipped with the run: most players never open it, and each one is a
// pair of range scans over a collection with millions of rows.
router.get("/games/guess-chatter/context.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channelLogin = cleanLogin(req.query.channel);
    const id = String(req.query.id || "");
    if (!isLogin(channelLogin) || !/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ ok: false, error: "params" });
    }

    const question = await questionsRepo.findById(channelLogin, new ObjectId(id));
    if (!question) return res.status(404).json({ ok: false, error: "question" });

    const { before, after } = await questionsRepo.getContext(
      channelLogin,
      question.ts,
      gc.CONTEXT_BEFORE,
      gc.CONTEXT_AFTER
    );

    // The asked-about line sits in the middle, where it was. Without it the panel is a set of
    // replies to a message that is not there, and matching the answer to what provoked it - which
    // is the whole reason to open the context - has to be done from memory of the card above.
    //
    // Spliced from the question document rather than fetched with the neighbours: the text is
    // already here, and asking `messages` for timestamp equality could return a different line
    // sent in the same millisecond.
    const lines = [
      ...before.map((l) => ({ userName: l.userName, message: l.message, isQuestion: false })),
      { userName: question.login, message: question.text, isQuestion: true },
      ...after.map((l) => ({ userName: l.userName, message: l.message, isQuestion: false })),
    ];

    // The context is chat too, so it carries its own emotes: the lines around a message are not
    // the ones the run was built from, and their emotes were never sent.
    const emoteMap = await emoteMapFor(channelLogin);

    // The author's name is replaced everywhere it can appear - as a sender and inside anybody's
    // text - because a neighbour answering "@login да ладно" is the answer printed in full, and so
    // is the author's own next line standing under their own name. The line being asked about is
    // masked like any other: its sender is the same person, and it is the one line that must not
    // print their name.
    res.json({
      ok: true,
      placeholder: gc.AUTHOR_PLACEHOLDER,
      emotes: pickUsedEmotes(lines.map((l) => l.message), emoteMap),
      lines: lines.map((l) => ({
        author: gc.maskAuthor(l.userName, question.login),
        text: gc.maskAuthor(l.message, question.login),
        isAuthor: String(l.userName || "").toLowerCase() === String(question.login || "").toLowerCase(),
        isQuestion: l.isQuestion,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// The play counter. GameSessionStats counts FINISHED sessions (see its own comment), and with the
// grading in the browser this is the only moment the server hears about one. Nothing else depends
// on it, so a lost call costs a tick of an admin statistic.
router.post("/games/guess-chatter/finish.json", runLimiter, verifyIfAuthed, async (req, res) => {
  await gameSessionStatsRepo.recordPlay(CATALOG_ID).catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
