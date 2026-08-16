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
  deriveExclusions,
} = require("./autoAnswerMatch");

const MAX_TITLE = 80;
// Twitch caps a chat message at 500 characters and the bot may prefix "@user ", so leave room.
const MAX_ANSWER = 400;
const MAX_EXAMPLES = 200;
const MAX_EXAMPLE_LENGTH = 300;
const MAX_ANTI_EXAMPLES = 200;
const MAX_REQUIRED_WORDS = 8;
// Альтернатив внутри одной группы «или» - «фильтр И (где|взять|скачать|ссылка|найти|...)».
const MAX_ALTERNATIVES_PER_GROUP = 30;
// Двадцати исключающих слов на живом чате не хватало: список заполнялся целиком, а часть
// помеченных сообщений оставалась незакрытой. Цена потолка измерена - постороннее сообщение
// со 100 исключениями разбирается за 0,067 мс, потому что обязательные слова проверяются
// первыми и отсеивают его ещё до списка исключений.
const MAX_WORDS = 100;
const MIN_WORD_LENGTH = 2;
const MAX_WORD_LENGTH = 30;
// A minute is already generous for "three people asked in a row"; an hour is the ceiling
// because beyond that the topic is effectively off and should say so via its mode.
// Порог «похоже на вопрос». Единица - почти любой текст со словами темы; выше шести тема
// молкнет совсем (сумма набирается парой признаков). Двойка - поведение по умолчанию.
const MIN_QUESTION_THRESHOLD = 1;
const MAX_QUESTION_THRESHOLD = 6;
const DEFAULT_QUESTION_THRESHOLD = 2;
const MIN_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 3600;
const DEFAULT_COOLDOWN_SECONDS = 300;

// Сколько непойманных примеров перечислять поимённо, прежде чем свернуть в счётчик.
const MAX_LISTED_WARNINGS = 3;

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

/**
 * Обязательные слова, где внутри одной записи допустимо «или»:
 *
 *     "фильтр, где|взять|скачать"  ->  ["фильтр", "где|взять|скачать"]
 *
 * Запятая разделяет группы (между ними «и»), «|» - альтернативы внутри группы. Длина
 * проверяется у каждой альтернативы отдельно, а не у всей записи: иначе «где|взять|скачать»
 * читалось бы как одно 18-символьное слово и прошло бы проверку целиком, включая пустые
 * куски от лишних палок.
 */
function parseRequiredGroups(value, maxGroups) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const alternatives = [];
    const altSeen = new Set();
    for (const part of String(item || "").split("|")) {
      const word = part.trim().toLowerCase();
      if (!word) continue;
      if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) continue;
      if (altSeen.has(word)) continue;
      altSeen.add(word);
      alternatives.push(word);
      if (alternatives.length >= MAX_ALTERNATIVES_PER_GROUP) break;
    }
    if (!alternatives.length) continue;
    const group = alternatives.join("|");
    if (seen.has(group)) continue;
    seen.add(group);
    out.push(group);
    if (out.length >= maxGroups) break;
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
 * `opts.ownLogins` - логины канала и бота. Нужны проверке правила его же примерами: примеры
 * копируются из чата и часто начинаются с «@stream», а тема по умолчанию молчит на
 * сообщениях, адресованных другому зрителю. Без них собственный пример темы отчитался бы
 * как непойманный.
 *
 * @returns {{ok: true, topic: object, warnings: string[]} | {ok: false, error: string}}
 */
function parseTopic(body = {}, opts = {}) {
  const title = String(body.title || "").trim();
  if (!title) return { ok: false, error: "title_required" };
  if (title.length > MAX_TITLE) return { ok: false, error: "title_too_long" };

  const answer = String(body.answer || "").trim();
  if (!answer) return { ok: false, error: "answer_required" };
  if (answer.length > MAX_ANSWER) return { ok: false, error: "answer_too_long" };

  const mode = MODES.includes(body.mode) ? body.mode : "test";

  const examples = parseLines(body.examples, MAX_EXAMPLES, MAX_EXAMPLE_LENGTH);
  // Одна и та же строка не может быть одновременно примером и антипримером: checkRule()
  // выдал бы про неё сразу два противоречивых вывода («не ловит свой пример» и «ловит
  // антипример»), а deriveExclusions() защищает слова примеров от попадания в исключения -
  // то есть на такой паре он не смог бы предложить ничего вообще. Пример выигрывает, потому
  // что примеры - это спецификация темы, а антипримеры лишь её уточнение.
  const seenAsExample = new Set(examples);
  const antiExamples = parseLines(body.antiExamples, MAX_ANTI_EXAMPLES, MAX_EXAMPLE_LENGTH)
    .filter((line) => !seenAsExample.has(line));

  const requiredWords = parseRequiredGroups(body.requiredWords, MAX_REQUIRED_WORDS);
  if (!requiredWords.length) return { ok: false, error: "required_words_required" };

  const optionalWords = parseWordList(body.optionalWords, MAX_WORDS);
  const excludeWords = parseWordList(body.excludeWords, MAX_WORDS);
  const notQuestionWords = parseWordList(body.notQuestionWords, MAX_WORDS);

  const rawThreshold = parseInt(body.questionThreshold, 10);
  const questionThreshold = Number.isFinite(rawThreshold)
    ? Math.min(Math.max(rawThreshold, MIN_QUESTION_THRESHOLD), MAX_QUESTION_THRESHOLD)
    : DEFAULT_QUESTION_THRESHOLD;

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
    // Галочка снята = поле не отправлено, поэтому здесь не может быть "!== false".
    skipModerators: body.skipModerators === "on" || body.skipModerators === true || body.skipModerators === "true",
    requireQuestion: body.requireQuestion === "on" || body.requireQuestion === true || body.requireQuestion === "true",
    questionThreshold,
    silentOnThirdPartyMention:
      body.silentOnThirdPartyMention === "on" ||
      body.silentOnThirdPartyMention === true ||
      body.silentOnThirdPartyMention === "true",
    cooldownSeconds,
  };

  return { ok: true, topic, warnings: describeWarnings(topic, opts.ownLogins) };
}

/**
 * Everything worth telling the moderator that isn't a refusal.
 *
 * Deliberately phrased as facts about their rule rather than as validation messages - the
 * moderator is authoring, not filling in a form, and "правило не ловит свой же пример" is
 * actionable in a way that "invalid input" is not.
 */
function describeWarnings(topic, ownLogins = []) {
  const warnings = [];
  const matcherTopic = toMatcherTopic(topic, { ownLogins });

  if (topic.examples.length) {
    const report = checkRule({
      topic: matcherTopic,
      examples: topic.examples,
      antiExamples: topic.antiExamples,
    });

    // Пример, который правило НЕ ловит - настоящая проблема и называется поимённо: он
    // означает, что тема пропустит такой вопрос в чате.
    for (const missed of report.missed.slice(0, MAX_LISTED_WARNINGS)) {
      warnings.push(`Правило не ловит собственный пример: «${missed.text}» — ${missed.reason}`);
    }
    if (report.missed.length > MAX_LISTED_WARNINGS) {
      warnings.push(`…и ещё ${report.missed.length - MAX_LISTED_WARNINGS} примеров, которые правило не ловит.`);
    }

    // А вот антипримеры - ОДНОЙ строкой, и вот почему. Модератор помечает их кнопкой «не то»
    // пачками, прямо в результатах прогона; ровно в этот момент правило на них, разумеется,
    // ещё срабатывает - исключающих слов он пока не добавлял. Строка на каждое помеченное
    // сообщение сообщает ему то, что он сам только что сказал системе, и на сотне помеченных
    // строк топит собой единственное предупреждение, которое читать НАДО (строка выше).
    //
    // И здесь НЕ предлагаются слова. Раньше предлагались - из checkRule().suggestedExclude,
    // который просто берёт все слова антипримера подряд («точно, подсвечивает, довольно,
    // часто»). Рядом живёт deriveExclusions с жадным покрытием, который на живых данных дал
    // 25 -> 4 шестью словами; держать два механизма и показывать по умолчанию худший - брак.
    // Поэтому строка называет кнопку, за которой стоит хороший.
    if (report.conflicts.length) {
      warnings.push(
        `Помеченных сообщений, на которых правило ещё срабатывает: ${report.conflicts.length}. ` +
          "Нажмите «Вывести исключающие слова» — они подберутся автоматически."
      );
    }
  } else {
    warnings.push("У темы нет ни одного примера — проверить её будет нечем.");
  }

  if (!topic.requireQuestion) {
    warnings.push(
      "Вопросительная форма не требуется: тема сработает и на утверждениях со своими словами."
    );
  }

  if (!topic.silentOnThirdPartyMention) {
    warnings.push(
      "Тема отвечает и на сообщения, адресованные другому зрителю — это разговоры чата " +
        "между собой, и на размеченной выборке они дали больше половины лишних ответов."
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
function suggestKeywords(examples, wordFrequency, emoteWords) {
  const lines = parseLines(examples, MAX_EXAMPLES, MAX_EXAMPLE_LENGTH);
  return deriveKeywords(lines, {
    wordFrequency: wordFrequency || new Map(),
    isEmote: makeIsEmote(emoteWords),
  });
}

/**
 * Suggest EXCLUDING words from the messages a moderator marked wrong - the mirror of
 * suggestKeywords, and what the «не то» button feeds.
 *
 * The real numbers behind this, measured on #mistercop's own month of logs: a topic keyed on
 * «фильтр» fired on 25 messages that were about CHANGING the filter rather than getting it
 * («а ты фильтр обновлял?», «тебе поменять фильтр?», «хочу заменить звук»). Marking those and
 * running this cut them to 4 while losing none of the 19 genuine questions in the same sample.
 */
function suggestExclusions(examples, antiExamples, opts = {}) {
  return deriveExclusions(
    parseLines(examples, MAX_EXAMPLES, MAX_EXAMPLE_LENGTH),
    parseLines(antiExamples, MAX_ANTI_EXAMPLES, MAX_EXAMPLE_LENGTH),
    {
      wordFrequency: opts.wordFrequency || new Map(),
      isEmote: makeIsEmote(opts.emoteWords),
      keywords: [
        ...parseWordList(opts.requiredWords, MAX_REQUIRED_WORDS),
        ...parseWordList(opts.optionalWords, MAX_WORDS),
      ],
      limit: MAX_WORDS,
    }
  );
}

const makeIsEmote = (emoteWords) =>
  emoteWords && emoteWords.size ? (word) => emoteWords.has(String(word).toLowerCase()) : undefined;

module.exports = {
  parseTopic,
  describeWarnings,
  suggestKeywords,
  suggestExclusions,
  parseWordList,
  parseRequiredGroups,
  parseLines,
  MODES,
  MAX_TITLE,
  MAX_ANSWER,
  MAX_EXAMPLES,
  MAX_EXAMPLE_LENGTH,
  MAX_REQUIRED_WORDS,
  MAX_ALTERNATIVES_PER_GROUP,
  MAX_WORDS,
  MIN_QUESTION_THRESHOLD,
  MAX_QUESTION_THRESHOLD,
  DEFAULT_QUESTION_THRESHOLD,
  MIN_COOLDOWN_SECONDS,
  MAX_COOLDOWN_SECONDS,
  DEFAULT_COOLDOWN_SECONDS,
};
