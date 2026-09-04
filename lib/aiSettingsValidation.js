// Parsing and bounds for the AI mention-reply settings - the global document (db/aiConfigRepo.js)
// and the per-channel block (channelConfigRepo.saveAiConfig).
//
// Extracted from the route for the usual reason in this repo: rules that deserve a test do not
// live inside a request handler. The bounds themselves are the interesting part - most of them
// exist because the value on the other side of them costs money or reaches chat.
// Список моделей, из которых выбирает панель. Держится в согласии с TwitchBot/games/aiProvider.js:
// поставщика бот определяет по имени модели (всё, что начинается на «gemini», уходит в Google), а
// ключ у каждого поставщика свой - в .env бота, не здесь. Модель, ключа которой у бота нет, просто
// оставит фичу молчащей: ответы уйдут скриптовым фразам, как при выключенном общем выключателе.
//
// gemini-3.5-flash-lite - единственная в списке с бесплатным тарифом Google. Он ограничен не
// деньгами, а числом запросов (смотреть в AI Studio, не здесь), и на нём Google учится на
// отправленном - то есть на сообщениях зрителей и памяти о них.
const MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "gemini-3.5-flash-lite"];
const PUNISH_MODES = ["observe", "enforce"];

const MAX_PERSONA_LEN = 4000;
// Потолка правил здесь больше нет: системный промт с сайта не сохраняется вовсе, поэтому и резать
// нечего. Правила живут в коде бота (SYSTEM_RULES), панель их только показывает.
const MAX_TONE_LEN = 1000;
const MAX_CHEATSHEET_LEN = 4000;

const BOUNDS = {
  // Zero is a legitimate setting: it stops the feature spending anything without touching the
  // master switch or any channel's own toggle.
  dailyRequestLimit: { min: 0, max: 10000 },
  cooldownSeconds: { min: 0, max: 3600 },
  // Twitch's own ceiling for a timeout is 14 days; past that it is a ban, which is a different
  // endpoint and a different decision than this feature is allowed to make.
  timeoutSeconds: { min: 1, max: 14 * 24 * 3600 },
  memoryPairs: { min: 0, max: 20 },
  memoryTtlDays: { min: 1, max: 365 },
  // How many facts a channel may HOLD. Not a spend bound any more: only the facts picked out for
  // the question reach the prompt (memoryRecall below), so this one bounds the collection an admin
  // has to curate, not the token count. Zero is legitimate - it leaves the memory switched off
  // without touching anything else.
  memoryMax: { min: 0, max: 1000 },
  // How many of them are sent with one question. THIS is the spend bound: every fact here is
  // input tokens on every billed call for the channel. Admin-written facts are sent on top of
  // this number - they are always included, which is the point of writing one by hand.
  memoryRecall: { min: 0, max: 50 },
  // A chat answer has a few seconds to be worth sending at all - a 30s ceiling is already far
  // past useful and exists only to stop a typo pinning a request open.
  requestTimeoutSeconds: { min: 1, max: 30 },
};

function clampInt(value, { min, max }, fallback) {
  const n = parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function trimTo(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

// Многострочное поле формы. Браузер отправляет переводы строк как CRLF, поэтому без нормализации
// в системный промпт уезжали бы лишние возвраты каретки, а сравнение со встроенным текстом не
// совпадало бы никогда - а на нём держится «правила следуют за кодом», см. ниже.
function trimLines(value, max) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function oneOf(value, allowed, fallback) {
  const v = String(value ?? "").trim();
  return allowed.includes(v) ? v : fallback;
}

// Every field is rendered on every save of this form, so an absent field means "cleared" for text
// and "off" for a checkbox - unlike the channel settings form, which is submitted in pieces from
// several pages and therefore has to carry unrendered fields over.
function parseGlobalConfig(body, existing) {
  return {
    enabled: body.enabled === "on",
    model: oneOf(body.model, MODELS, existing.model),
    dailyRequestLimit: clampInt(body.dailyRequestLimit, BOUNDS.dailyRequestLimit, existing.dailyRequestLimit),
    cooldownMs:
      clampInt(body.cooldownSeconds, BOUNDS.cooldownSeconds, Math.round(existing.cooldownMs / 1000)) * 1000,
    requestTimeoutMs:
      clampInt(
        body.requestTimeoutSeconds,
        BOUNDS.requestTimeoutSeconds,
        Math.round(existing.requestTimeoutMs / 1000)
      ) * 1000,
    timeoutSeconds: clampInt(body.timeoutSeconds, BOUNDS.timeoutSeconds, existing.timeoutSeconds),
    punishMode: oneOf(body.punishMode, PUNISH_MODES, existing.punishMode),
    memoryPairs: clampInt(body.memoryPairs, BOUNDS.memoryPairs, existing.memoryPairs),
    memoryTtlDays: clampInt(body.memoryTtlDays, BOUNDS.memoryTtlDays, existing.memoryTtlDays),
    memoryEnabled: body.memoryEnabled === "on",
    memoryMax: clampInt(body.memoryMax, BOUNDS.memoryMax, existing.memoryMax),
    memoryRecall: clampInt(body.memoryRecall, BOUNDS.memoryRecall, existing.memoryRecall),
    persona: trimLines(body.persona, MAX_PERSONA_LEN),
    // СИСТЕМНОГО ПРОМТА ЗДЕСЬ НЕТ, И ЭТО НЕ ПРОПУСК. С сайта его только читают: правила живут в
    // коде бота (SYSTEM_RULES), а панель показывает копию, которую бот сам туда публикует. Поле не
    // просто убрано из формы - его нет в разбираемом теле, поэтому подделанный POST с systemPrompt
    // тоже ничего не меняет: чего нет в возвращённом объекте, того нет и в $set.
    //
    // Значение, сохранённое прежней формой, при этом не стирается и продолжает работать у бота:
    // молча удалить чужие правила сохранением любой другой настройки - худший из возможных
    // исходов, и «только читать» такого не просит. Видно его на той же странице - подпись над
    // текстом говорит, чьи правила в силе, а сверка под ним, чем они отличаются от встроенных.
  };
}

function parseChannelAi(body) {
  return {
    enabled: body.aiEnabled === "on",
    tone: trimTo(body.aiTone, MAX_TONE_LEN),
    cheatsheet: trimTo(body.aiCheatsheet, MAX_CHEATSHEET_LEN),
  };
}

module.exports = {
  MODELS,
  PUNISH_MODES,
  BOUNDS,
  MAX_PERSONA_LEN,
  MAX_TONE_LEN,
  MAX_CHEATSHEET_LEN,
  parseGlobalConfig,
  parseChannelAi,
};
