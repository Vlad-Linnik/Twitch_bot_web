// /<channel>/auto-answers - the moderator's console for auto-answer topics.
//
// The workflow this page exists to serve, in the owner's own words: notice the chat asking the
// same thing over and over, come here, write the question a few times plus one universal
// answer, let the bot work out the keywords (or set them by hand), and watch it in test mode
// before letting it speak.
//
// Four things follow from that and shape every route below:
//
//   - A new topic is created in `test` and nothing reaches chat until a human moves it to
//     `live`. There is a per-topic mode rather than one site-wide switch, because a global one
//     would mean you cannot try a new topic without silencing the working ones.
//   - "Проверить по логам" replays the rule over the channel's own history BEFORE it has ever
//     run. On a question asked ~10 times a month, waiting for test mode to accumulate evidence
//     would take weeks; the same evidence is already sitting in `messages`.
//   - Keyword suggestion is a button, not magic: it proposes chips, the moderator edits them.
//     Nothing is learned or stored beyond what is on screen (see lib/autoAnswerMatch.js).
//   - Every rejection and every hit carries its reason, so «не то» can be a single click that
//     turns a false positive into an anti-example.
//
// Tier <= 2 throughout: these are WRITES to bot behaviour, exactly like counters/commands.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const autoAnswersRepo = require("../db/autoAnswersRepo");
const autoAnswerHitsRepo = require("../db/autoAnswerHitsRepo");
const statsRepo = require("../db/statsRepo");
const wordStatsRepo = require("../db/wordStatsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSettingsEditAccess, computePermission } = require("../middleware/permissions");
const { settingsWriteLimiter, searchLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const { stem } = require("../lib/russianStemmer");
const matcher = require("../lib/autoAnswerMatch");
const validation = require("../lib/autoAnswerValidation");

const router = express.Router();

// Same local helper routes/statistics.js and routes/unbanBureau.js already define - a JSON
// endpoint must answer 401/403 as JSON, not render an HTML error page into a fetch().
function requireLevelJson(maxLevel) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.userId ?? null;
      const level = await computePermission(userId, req.params.channel);
      if (level > maxLevel) {
        return res.status(userId ? 403 : 401).json({ error: userId ? "forbidden" : "unauthenticated" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const REPLAY_MAX_DAYS = 180;
const REPLAY_DEFAULT_DAYS = 30;
const REPLAY_MAX_RESULTS = 60;

/**
 * Что этот канал знает про свои слова: частотность (ранжирование по редкости) и множество
 * эмоутов (их нельзя предлагать ни ключевыми, ни исключающими словами).
 *
 * И то и другое - улучшение, а не требование: канал без ChatWordStats и без синхронизированных
 * эмоутов получит корректные слова, просто отсортированные хуже. Поэтому обе выборки падают
 * молча в пустое множество, а не роняют кнопку, ради которой модератор сюда пришёл.
 */
async function channelVocabulary(channelLogin) {
  const [wordFrequency, emoteWords] = await Promise.all([
    wordStatsRepo.getStemFrequency(channelLogin, stem).catch(() => new Map()),
    wordStatsRepo.getEmoteWordSet(channelLogin).catch(() => new Set()),
  ]);
  return { wordFrequency, emoteWords };
}

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// --- the page --------------------------------------------------------------------------

router.get("/:channel/auto-answers", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const [topics, counts, hits] = await Promise.all([
      autoAnswersRepo.list(channel.channelLogin),
      autoAnswerHitsRepo.countsByTopic(channel.channelLogin),
      autoAnswerHitsRepo.listRecent(channel.channelLogin, { limit: 50 }),
    ]);

    const editing = req.query.edit
      ? topics.find((t) => String(t._id) === String(req.query.edit)) || null
      : null;

    res.render("channelAutoAnswers", {
      channel,
      topics: topics.map((t) => ({ ...t, id: String(t._id), hits: counts.get(String(t._id)) || null })),
      hits: hits.map((h) => ({ ...h, id: String(h._id), topicId: String(h.topicId) })),
      editing: editing ? { ...editing, id: String(editing._id) } : null,
      creating: req.query.new === "1",
      limits: validation,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

// --- create / update / delete ----------------------------------------------------------

router.post(
  "/:channel/auto-answers",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;
      const back = `/${channel.channelLogin}/auto-answers`;

      if (req.body.action === "delete") {
        const before = await autoAnswersRepo.findById(channel.channelLogin, req.body.id);
        if (!before) return res.redirect(`${back}?error=not_found`);
        await autoAnswersRepo.remove(channel.channelLogin, req.body.id);
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "autoAnswer",
          action: "delete", target: before.title, before, after: null,
        });
        return res.redirect(`${back}?saved=deleted`);
      }

      // The mode switch on a topic card posts only id+mode. Parsing that through parseTopic()
      // would demand a title and an answer it never sent and reject a legitimate one-click
      // change, so it is its own branch.
      if (req.body.action === "mode") {
        const before = await autoAnswersRepo.findById(channel.channelLogin, req.body.id);
        if (!before) return res.redirect(`${back}?error=not_found`);
        if (!validation.MODES.includes(req.body.mode)) return res.redirect(`${back}?error=bad_mode`);
        const after = await autoAnswersRepo.update(channel.channelLogin, req.body.id, { mode: req.body.mode });
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "autoAnswer",
          action: "update", target: before.title, before, after,
        });
        return res.redirect(`${back}?saved=mode`);
      }

      const parsed = validation.parseTopic(req.body);
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

      if (req.body.id) {
        const before = await autoAnswersRepo.findById(channel.channelLogin, req.body.id);
        if (!before) return res.redirect(`${back}?error=not_found`);
        const after = await autoAnswersRepo.update(channel.channelLogin, req.body.id, parsed.topic);
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "autoAnswer",
          action: "update", target: parsed.topic.title, before, after,
        });
      } else {
        const after = await autoAnswersRepo.create(channel.channelLogin, parsed.topic, req.user);
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "autoAnswer",
          action: "add", target: parsed.topic.title, before: null, after,
        });
      }
      // The bot re-reads topics on its own refresh tick, so this is live within seconds.
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

// --- keyword suggestion ----------------------------------------------------------------

router.post(
  "/:channel/auto-answers/derive.json",
  requireLevelJson(2),
  searchLimiter,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });

      const { wordFrequency, emoteWords } = await channelVocabulary(channel.channelLogin);
      const derived = validation.suggestKeywords(req.body.examples, wordFrequency, emoteWords);
      res.json({
        required: derived.required,
        optional: derived.optional,
        warning: derived.warning,
      });
    } catch (err) {
      next(err);
    }
  }
);

// --- исключающие слова из помеченных ложных срабатываний ---------------------------------

router.post(
  "/:channel/auto-answers/exclusions.json",
  requireLevelJson(2),
  searchLimiter,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });

      const { wordFrequency, emoteWords } = await channelVocabulary(channel.channelLogin);
      const derived = validation.suggestExclusions(req.body.examples, req.body.antiExamples, {
        wordFrequency,
        emoteWords,
        requiredWords: req.body.requiredWords,
        optionalWords: req.body.optionalWords,
      });
      res.json(derived);
    } catch (err) {
      next(err);
    }
  }
);

// --- replay over the channel's own history ----------------------------------------------

router.post(
  "/:channel/auto-answers/replay.json",
  requireLevelJson(2),
  searchLimiter,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });

      const parsed = validation.parseTopic(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const rawDays = parseInt(req.body.days, 10);
      const days = Number.isFinite(rawDays)
        ? Math.min(Math.max(rawDays, 1), REPLAY_MAX_DAYS)
        : REPLAY_DEFAULT_DAYS;
      const since = new Date(Date.now() - days * 86400000);

      const topic = matcher.toMatcherTopic(parsed.topic);
      const candidates = await statsRepo.scanRecentMessages(channel.channelLogin, {
        since,
        contains: parsed.topic.requiredWords,
      });

      const hits = [];
      const nearMisses = [];
      let blocked = 0;

      for (const doc of candidates) {
        const analysis = matcher.analyzeMessage(doc.message);
        const match = matcher.matchTopic(analysis, topic);

        if (match.matched) {
          hits.push({
            at: doc.timestamp,
            userName: doc.userName,
            message: doc.message,
            spans: match.spans,
            how: [...match.matchedRequired, ...match.matchedOptional].map((m) => m.how),
          });
          continue;
        }
        if (match.blockedBy) {
          blocked += 1;
          continue;
        }
        // What the question gate is buying: the topic's words are all there, and it still
        // stayed quiet. This is the list a moderator checks when a rule feels too silent.
        if (topic.requireQuestion && String(match.reason).startsWith("не похоже на вопрос")) {
          const loose = matcher.matchTopic(analysis, { ...topic, requireQuestion: false });
          if (loose.matched) {
            nearMisses.push({
              at: doc.timestamp,
              userName: doc.userName,
              message: doc.message,
              spans: loose.spans,
              against: analysis.question.signals.filter((s) => s.weight <= 0).map((s) => s.label),
              score: analysis.question.score,
              threshold: analysis.question.threshold,
            });
          }
        }
      }

      // Same 5-minute-per-topic cooldown the bot applies, so the headline number is what
      // would actually have been SAID rather than what merely matched.
      const cooldownMs = (parsed.topic.cooldownSeconds || 300) * 1000;
      const ordered = [...hits].sort((a, b) => new Date(a.at) - new Date(b.at));
      let sends = 0;
      let lastSent = -Infinity;
      for (const hit of ordered) {
        const t = new Date(hit.at).getTime();
        if (t - lastSent >= cooldownMs) { sends += 1; lastSent = t; }
      }

      res.json({
        days,
        scanned: candidates.length,
        matched: hits.length,
        wouldSend: sends,
        blocked,
        askers: new Set(hits.map((h) => String(h.userName).toLowerCase())).size,
        warnings: parsed.warnings,
        hits: hits.slice(0, REPLAY_MAX_RESULTS),
        nearMisses: nearMisses.slice(0, REPLAY_MAX_RESULTS),
        nearMissTotal: nearMisses.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// --- «не то» on a hit -------------------------------------------------------------------

router.post(
  "/:channel/auto-answers/review.json",
  requireLevelJson(2),
  settingsWriteLimiter,
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });

      const hit = await autoAnswerHitsRepo.findById(channel.channelLogin, req.body.id);
      if (!hit) return res.status(404).json({ error: "not_found" });

      const falsePositive = req.body.review === "false_positive";
      await autoAnswerHitsRepo.setReview(channel.channelLogin, req.body.id, falsePositive ? "false_positive" : null);

      // Marking it is only half the job - the point is that the rule stops doing it. The
      // message goes into the topic's anti-examples, where checkRule() will report it as a
      // conflict until the moderator narrows the rule enough to close it.
      let conflictsRemaining = null;
      if (falsePositive && hit.topicId) {
        const topic = await autoAnswersRepo.addAntiExample(channel.channelLogin, hit.topicId, hit.message);
        if (topic) {
          const report = matcher.checkRule({
            topic: matcher.toMatcherTopic(topic),
            examples: topic.examples || [],
            antiExamples: topic.antiExamples || [],
          });
          conflictsRemaining = report.conflicts.map((c) => ({
            text: c.text,
            suggestedExclude: c.suggestedExclude.slice(0, 4).map((s) => s.label),
          }));
        }
      }

      res.json({ ok: true, review: falsePositive ? "false_positive" : null, conflictsRemaining });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
