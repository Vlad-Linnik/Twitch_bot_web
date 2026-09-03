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
  return emoteImages.getEmoteImageMap(channel.channelId).catch(() => new Map());
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
    const drawn = await questionsRepo.drawQuestions(channelLogin, poolIds);
    const candidates = gc.pickRunQuestions(drawn.strict, drawn.loose);

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
    // own lines. Over-drawn by one because the question itself may come back in the sample.
    const hintLines = await Promise.all(
      rounds.map((r) =>
        questionsRepo.drawAuthorLines(channelLogin, r.question.userId, gc.HINTS + 1).catch(() => [])
      )
    );

    const hints = rounds.map((r, i) => gc.pickHints(hintLines[i], r.question._id).map((h) => h.text));

    const [profiles, emoteMap] = await Promise.all([
      profileMap(rounds.flatMap((r) => r.options.map((o) => o.userId))),
      emoteMapFor(channelLogin),
    ]);

    res.json({
      ok: true,
      channel: channelLogin,
      // Only the emotes these lines actually use, not the channel's whole set - see
      // lib/chatEmotes.js. The client swaps names for pictures; a name with no picture here stays
      // text, which is what the message said anyway.
      emotes: pickUsedEmotes([...rounds.map((r) => r.question.text), ...hints.flat()], emoteMap),
      rounds: rounds.map((r, i) => ({
        id: String(r.question._id),
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

    const lines = await questionsRepo.getContext(
      channelLogin,
      question.ts,
      gc.CONTEXT_BEFORE,
      gc.CONTEXT_AFTER
    );

    // The context is chat too, so it carries its own emotes: the lines around a message are not
    // the ones the run was built from, and their emotes were never sent.
    const emoteMap = await emoteMapFor(channelLogin);

    // The author's name is replaced everywhere it can appear - as a sender and inside anybody's
    // text - because a neighbour answering "@login да ладно" is the answer printed in full, and so
    // is the author's own next line standing under their own name.
    res.json({
      ok: true,
      placeholder: gc.AUTHOR_PLACEHOLDER,
      emotes: pickUsedEmotes(lines.map((l) => l.message), emoteMap),
      lines: lines.map((l) => ({
        author: gc.maskAuthor(l.userName, question.login),
        text: gc.maskAuthor(l.message, question.login),
        isAuthor: String(l.userName || "").toLowerCase() === String(question.login || "").toLowerCase(),
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
