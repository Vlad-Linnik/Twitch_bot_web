// Parsing and validation for an auto-answer topic, extracted out of routes/autoAnswers.js so
// it's unit-testable without Express or Mongo - the pattern lib/settingsValidation.js set.
//
// Two jobs, and the second is the interesting one:
//
//   1. Ordinary bounds checking (lengths, counts, the three allowed modes).
//   2. Running the topic against its OWN examples before it is allowed to be saved. A rule
//      that doesn't catch the questions it was built from is broken, and the moderator has no
//      other way to find that out - the chips look fine, the answer looks fine, and the bot
//      just silently never fires. checkRule() answers that in microseconds, so there is no
//      reason to let a broken rule reach the database.
//
// Point 2 comes back as a WARNING, not an error, on purpose. A moderator narrowing a rule on
// purpose (adding an exclude word that kills one old example) must not be blocked by it -
// they can see the warning and decide. Only genuinely unusable input is refused.
const {
  checkRule,
  toMatcherTopic,
  deriveKeywords,
  analyzeMessage,
  matchTopic,
} = require("./autoAnswerMatch");

const MAX_TITLE = 80;
// Twitch caps a chat message at 500 characters and the bot may prefix "@user ", so leave room.
const MAX_ANSWER = 400;
const MAX_EXAMPLES = 20;
const MAX_EXAMPLE_LENGTH = 300;
const MAX_ANTI_EXAMPLES = 50;
const MAX_REQUIRED_WORDS = 5;
const MAX_WORDS = 20;
const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 30;
// A minute is already generous for "three people asked in a row"; an hour is the ceiling
// because beyond that the topic is effectively off and should say so via its mode.
const MIN_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 3600;
const DEFAULT_COOLDOWN_SECONDS = 300;

const MODES = ["off", "test", "live"];

/** "фильтр, ссф , левелинг" -> ["фильтр", "ссф", "левелинг"], deduped, order kept. */
function parseWordList(value, max) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const word = String(item || "").trim().toLowerCase();
    if (!word) continue;
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/** One example per line. Blank lines are dropped rather than saved as empty examples. */
function parseLines(value, max, maxLength) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const line = String(item || "").trim();
    if (!line || line.length > maxLength) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Parse a submitted topic form.
 *
 * @returns {{ok: true, topic: object, warnings: string[]} | {ok: false, error: string}}
 */
function parseTopic(body = {}) {
  const title = String(body.title || "").trim();
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > MAX_TITLE) return { ok: false, error: "title_too_long" };

  const answer = String(body.answer || "").trim();
  if (!answer) return { ok: false, error: "answer_required" };
  if (answer.length > MAX_ANSWER) return { ok: false, error: "answer_too_long" };

  const mode = MODES.includes(body.mode) ? body.mode : "test";

  const examples = parseLines(body.examples, MAX_EXAMPLES, MAX_EXAMPLE_LENGTH);
  const antiExamples = parseLines(body.antiExamples, MAX_ANTI_EXAMPLES, MAX_EXAMPLE_LENGTH);

  const requiredWords = parseWordList(body.requiredWords, MAX_REQUIRED_WORDS);
  if (!requiredWords.length) return { ok: false, error: "required_words_required" };

  const optionalWords = parseWordList(body.optionalWords, MAX_WORDS);
  const excludeWords = parseWordList(body.excludeWords, MAX_WORDS);
  const notQuestionWords = parseWordList(body.notQuestionWords, MAX_WORDS);

  const rawCooldown = parseInt(body.cooldownSeconds, 10);
  const cooldownSeconds = Number.isFinite(rawCooldown)
    ? Math.min(Math.max(rawCooldown, MIN_COOLDOWN_SECONDS), MAX_COOLDOWN_SECONDS)
    : DEFAULT_COOLDOWN_SECONDS;

  const topic = {
    title,
    answer,
    mode,
    examples,
    antiExamples,
    requiredWords,
    optionalWords,
    excludeWords,
    notQuestionWords,
    // Absent from the body means the checkbox was unticked - a checkbox that isn't checked
    // simply isn't submitted, so this cannot be `!== false` the way the matcher's own default is.
    requireQuestion: body.requireQuestion === "on" || body.requireQuestion === true || body.requireQuestion === "true",
    cooldownSeconds,
  };

  return { ok: true, topic, warnings: describeWarnings(topic) };
}

/**
 * Everything worth telling the moderator that isn't a refusal.
 *
 * Deliberately phrased as facts about their rule rather than as validation messages - the
 * moderator is authoring, not filling in a form, and "правило не ловит свой же пример" is
 * actionable in a way that "invalid input" is not.
 */
function describeWarnings(topic) {
  const warnings = [];
  const matcherTopic = toMatcherTopic(topic);

  if (topic.examples.length) {
    const report = checkRule({
      topic: matcherTopic,
      examples: topic.examples,
      antiExamples: topic.antiExamples,
    });
    for (const missed of report.missed) {
      warnings.push(`Правило не ловит собственный пример: «${missed.text}» — ${missed.reason}`);
    }
    for (const conflict of report.conflicts) {
      const suggest = conflict.suggestedExclude.slice(0, 4).map((s) => s.label).join(", ");
      warnings.push(
        `Правило срабатывает на антипримере «${conflict.text}»` +
          (suggest ? ` — попробуйте исключающее слово: ${suggest}` : "")
      );
    }
  } else {
    warnings.push("У темы нет ни одного примера — проверить её будет нечем.");
  }

  // A topic whose answer would itself trigger the topic is an infinite loop waiting for a
  // channel where the bot is also a listed chatter. The bot ignores its own messages, so this
  // cannot actually loop today - it's a warning rather than a refusal because the wording may
  // be deliberate ("мой фильтр: ...") and refusing it would block a perfectly good answer.
  const selfHit = matchTopic(analyzeMessage(topic.answer), {
    ...matcherTopic,
    requireQuestion: false,
  });
  if (selfHit.matched) {
    warnings.push("Текст ответа сам подходит под правило темы — проверьте, что бот не отвечает сам себе.");
  }

  if (!topic.requireQuestion) {
    warnings.push(
      "Вопросительная форма не требуется: тема сработает и на утверждениях со своими словами."
    );
  }

  return warnings;
}

/**
 * Suggest keywords from examples - what the "вывести из примеров" button calls.
 *
 * Thin wrapper over the shared deriveKeywords so the route stays free of matcher internals,
 * and so the channel's own word frequency (rarity ranking) is optional rather than required.
 */
function suggestKeywords(examples, wordFrequency) {
  const lines = parseLines(examples, MAX_EXAMPLES, MAX_EXAMPLE_LENGTH);
  return deriveKeywords(lines, { wordFrequency: wordFrequency || new Map() });
}

module.exports = {
  parseTopic,
  describeWarnings,
  suggestKeywords,
  parseWordList,
  parseLines,
  MODES,
  MAX_TITLE,
  MAX_ANSWER,
  MAX_EXAMPLES,
  MAX_EXAMPLE_LENGTH,
  MAX_REQUIRED_WORDS,
  MAX_WORDS,
  MIN_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
};
