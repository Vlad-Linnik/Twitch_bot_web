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
// Правила длиннее характера: это несколько блоков с жёсткими запретами, памятью канала и
// подсказкой про повторный вопрос. Потолок нужен не для экономии - текст уходит в кэшируемую
// часть промта, - а чтобы вставленный по ошибке лог не превратился в системное сообщение.
const MAX_SYSTEM_PROMPT_LEN = 8000;
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
  // the question reach the prompt (channelMemoryRecall below), so this one bounds the collection
  // an admin has to curate, not the token count. Zero is legitimate - it leaves the memory
  // switched off without touching anything else.
  channelMemoryMax: { min: 0, max: 1000 },
  // How many of them are sent with one question. THIS is the spend bound: every fact here is
  // input tokens on every billed call for the channel. Admin-written facts are sent on top of
  // this number - they are always included, which is the point of writing one by hand.
  channelMemoryRecall: { min: 0, max: 50 },
  // Сколько фактов бот держит про одного зрителя. Это и хранилище, и расход сразу: в запрос уходит
  // память только тех, кто участвует в разговоре, поэтому второго числа тут нет. Потолок ниже, чем
  // у канала, по той же причине - строки читаются целиком, без отбора по словам вопроса.
  userMemoryMax: { min: 0, max: 100 },
  // Во сколько раз мут может стать длиннее базового timeoutSeconds на самом дне шкалы отношения.
  // Единица - это «шкала на срок не влияет», то есть выключить удлинение можно, не выключая саму
  // шкалу. Форма кривой остаётся константой в коде бота (TwitchBot/shared/rapport.js, ручная копия
  // lib/rapport.js): крутится здесь потолок, а не наклон.
  rapportMaxMultiplier: { min: 1, max: 10 },
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
    channelMemoryEnabled: body.channelMemoryEnabled === "on",
    channelMemoryMax: clampInt(body.channelMemoryMax, BOUNDS.channelMemoryMax, existing.channelMemoryMax),
    channelMemoryRecall: clampInt(
      body.channelMemoryRecall,
      BOUNDS.channelMemoryRecall,
      existing.channelMemoryRecall
    ),
    userMemoryEnabled: body.userMemoryEnabled === "on",
    userMemoryMax: clampInt(body.userMemoryMax, BOUNDS.userMemoryMax, existing.userMemoryMax),
    rapportEnabled: body.rapportEnabled === "on",
    rapportMaxMultiplier: clampInt(
      body.rapportMaxMultiplier,
      BOUNDS.rapportMaxMultiplier,
      existing.rapportMaxMultiplier
    ),
    persona: trimLines(body.persona, MAX_PERSONA_LEN),
    // В форме поле всегда заполнено - в нём лежит текст, который сейчас работает, чтобы правила
    // можно было править по строчке, а не только заменять целиком. Поэтому «оставить как есть»
    // нельзя отличить от «сохранить встроенные» по пустоте поля, и решает сравнение: текст,
    // дословно совпавший со встроенным, хранится как ПУСТОЙ.
    //
    // Разница не косметическая. Пустое значение означает «брать правила из кода», то есть после
    // деплоя, поменявшего SYSTEM_RULES, канал получит новые. Сохранённая копия так не умеет и
    // тихо застынет на версии, которую однажды нажали. Пустота - это подписка на код, и терять
    // её из-за того, что человек открыл форму и нажал «Сохранить», ничего не изменив, неправильно.
    systemPrompt:
      trimLines(body.systemPrompt, MAX_SYSTEM_PROMPT_LEN) === trimLines(existing.builtinSystemPrompt, MAX_SYSTEM_PROMPT_LEN)
        ? ""
        : trimLines(body.systemPrompt, MAX_SYSTEM_PROMPT_LEN),
  };
}

function parseChannelAi(body) {
  return {
    enabled: body.aiEnabled === "on",
    tone: trimTo(body.aiTone, MAX_TONE_LEN),
    cheatsheet: trimTo(body.aiCheatsheet, MAX_CHEATSHEET_LEN),
    // Делит ли канал память о зрителях с другими каналами с той же галкой. Память КАНАЛА этим не
    // делится: «во что играем» имеет разный правильный ответ в каждом чате, а «играет на гитаре» -
    // один и тот же. Отдавать своё и читать чужое - одна галка, а не две: канал, который читает,
    // но не отдаёт, превращает общую память в одностороннюю выгрузку.
    memoryShare: body.aiMemoryShare === "on",
  };
}

module.exports = {
  MODELS,
  PUNISH_MODES,
  BOUNDS,
  MAX_PERSONA_LEN,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_TONE_LEN,
  MAX_CHEATSHEET_LEN,
  parseGlobalConfig,
  parseChannelAi,
};
