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
// В списке только модели с бесплатным тарифом Google (проверено по странице цен 2026-11-19).
// Платные - Claude и прочие - убраны намеренно: фича должна работать без счёта. Бот их при этом
// по-прежнему умеет (games/aiProvider.js), и уже сохранённая в базе модель вне списка формой не
// затирается. Бесплатный тариф ограничен не деньгами, а числом запросов (смотреть в AI Studio, не
// здесь), и на нём Google учится на отправленном - то есть на сообщениях зрителей и памяти о них.
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"];
const PUNISH_MODES = ["observe", "enforce"];

const MAX_PERSONA_LEN = 4000;
// Потолок правил. Встроенный текст сейчас около восьми тысяч знаков; запас вдвое с лишним, чтобы
// дописать свой раздел было можно, а вставить по ошибке простыню, которая уйдёт в КАЖДЫЙ вызов
// (это входные токены на каждом ответе), - нельзя.
const MAX_SYSTEM_PROMPT_LEN = 20000;
const MAX_TONE_LEN = 1000;
const MAX_CHEATSHEET_LEN = 4000;
// Сколько человек, кроме стримера и модераторов, могут просить бота о муте. Потолок небольшой
// намеренно: это список поимённо выданных прав, а не роль - если он вырос до сотни, значит выдавали
// не думая. Длина логина в Twitch - 25 символов.
const MAX_BAN_REQUESTERS = 30;
const MAX_LOGIN_LEN = 25;

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
    fallbackModel: parseFallbackModel(body, existing),
    dailyRequestLimit: clampInt(body.dailyRequestLimit, BOUNDS.dailyRequestLimit, existing.dailyRequestLimit),
    cooldownMs:
      clampInt(body.cooldownSeconds, BOUNDS.cooldownSeconds, Math.round(existing.cooldownMs / 1000)) * 1000,
    requestTimeoutMs:
      clampInt(
        body.requestTimeoutSeconds,
        BOUNDS.requestTimeoutSeconds,
        Math.round(existing.requestTimeoutMs / 1000)
      ) * 1000,
    ...parseTimeoutTiers(body, existing),
    punishMode: oneOf(body.punishMode, PUNISH_MODES, existing.punishMode),
    memoryPairs: clampInt(body.memoryPairs, BOUNDS.memoryPairs, existing.memoryPairs),
    memoryTtlDays: clampInt(body.memoryTtlDays, BOUNDS.memoryTtlDays, existing.memoryTtlDays),
    memoryEnabled: body.memoryEnabled === "on",
    memoryMax: clampInt(body.memoryMax, BOUNDS.memoryMax, existing.memoryMax),
    memoryRecall: clampInt(body.memoryRecall, BOUNDS.memoryRecall, existing.memoryRecall),
    persona: trimLines(body.persona, MAX_PERSONA_LEN),
    systemPrompt: parseSystemPrompt(body, existing),
  };
}

// Запасная модель. "none" в форме - запасной нет (в базе пусто). Поля нет в теле (страница
// открыта до выкатки) - значение не трогается, а у документа без поля бот берёт умолчание из кода.
const FALLBACK_NONE = "none";
function parseFallbackModel(body, existing) {
  if (body.fallbackModel === undefined) return existing.fallbackModel;
  const v = String(body.fallbackModel).trim();
  if (v === FALLBACK_NONE) return "";
  return MODELS.includes(v) ? v : existing.fallbackModel;
}

// Срок тайм-аута по трём ступеням тяжести. timeoutSeconds - средняя: под этим именем срок жил,
// пока ступеней не было. Порядок ступеней сохраняется при записи (лёгкая не длиннее средней,
// тяжёлая не короче), и бот держит его же при чтении - опечатка в одном поле не должна делать
// мелкую выходку дороже грубой.
function parseTimeoutTiers(body, existing) {
  const medium = clampInt(body.timeoutSeconds, BOUNDS.timeoutSeconds, existing.timeoutSeconds);
  const light = clampInt(body.timeoutSecondsLight, BOUNDS.timeoutSeconds, existing.timeoutSecondsLight);
  const severe = clampInt(body.timeoutSecondsSevere, BOUNDS.timeoutSeconds, existing.timeoutSecondsSevere);
  return {
    timeoutSecondsLight: Math.min(light, medium),
    timeoutSeconds: medium,
    timeoutSecondsSevere: Math.max(severe, medium),
  };
}

// Правила целиком. Пустая строка в базе значит «работают встроенные из кода бота» - и это не
// просто умолчание, а единственное состояние, в котором до бота доходят правки политики в коде.
// Поэтому текст, совпавший со встроенным, сохраняется ПУСТЫМ: форма показывает встроенные правила
// в поле, и сохранение любой другой настройки иначе молча замораживало бы их копию в базе.
//
// Поля нет в теле вовсе (страница открыта до выкатки, подделанный POST) - значение не трогается:
// стереть чужие правила сохранением лимита хуже, чем не сохранить правку, которой не было.
// Явный сброс - галка systemPromptReset, она главнее текста.
function parseSystemPrompt(body, existing) {
  if (body.systemPromptReset === "on") return "";
  if (body.systemPrompt === undefined) return String(existing.systemPrompt || "");
  const text = trimLines(body.systemPrompt, MAX_SYSTEM_PROMPT_LEN);
  const builtin = trimLines(existing.builtinSystemPrompt, Infinity);
  if (!text || (builtin && text === builtin)) return "";
  return text;
}

// Список логинов из одного поля формы. Разделителем считается что угодно, кроме самого логина:
// перенос строки, запятая, пробел - человек вставляет такой список как придётся, и требовать от
// него формата незачем. «@» снимается, регистр опускается, повторы схлопываются - бот сравнивает
// строкой, и «@Vasya» рядом с «vasya» иначе стали бы двумя разными правами.
function parseBanRequesters(value) {
  const seen = new Set();
  for (const raw of String(value ?? "").split(/[^A-Za-z0-9_]+/)) {
    const login = raw.trim().toLowerCase();
    if (!login || login.length > MAX_LOGIN_LEN) continue;
    seen.add(login);
    if (seen.size >= MAX_BAN_REQUESTERS) break;
  }
  return [...seen];
}

function parseChannelAi(body) {
  return {
    enabled: body.aiEnabled === "on",
    tone: trimTo(body.aiTone, MAX_TONE_LEN),
    cheatsheet: trimTo(body.aiCheatsheet, MAX_CHEATSHEET_LEN),
    banRequesters: parseBanRequesters(body.aiBanRequesters),
  };
}

module.exports = {
  MODELS,
  FALLBACK_NONE,
  PUNISH_MODES,
  BOUNDS,
  MAX_PERSONA_LEN,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_TONE_LEN,
  MAX_CHEATSHEET_LEN,
  MAX_BAN_REQUESTERS,
  parseBanRequesters,
  parseGlobalConfig,
  parseChannelAi,
};
