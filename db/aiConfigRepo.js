// The one global settings document for the AI mention replies - persona, model, daily budget and
// the limits that apply to every channel at once. Written by the admin panel (routes/adminAi.js),
// read by the bot (TwitchBot/config/aiSettings.js) with its own short-TTL cache.
//
// WHY GLOBAL AND NOT PER-CHANNEL. Everything here is one setting for the whole bot: one API key,
// one budget, one persona. Copying it into each channel's ChannelConfig would mean editing the
// model or the daily limit in as many places as there are channels. The per-channel half of this
// feature (enabled / tone / cheatsheet) lives in ChannelConfig's `ai` block instead - see
// channelConfigRepo.saveAiConfig.
//
// Lives in twitch_chat_stats, not the web db, for the usual reason: the bot has to read it, and
// the bot only ever opens that database.
const { connect } = require("./connection");

// Hand-kept in sync with TwitchBot/config/aiSettings.js's DEFAULT_AI_CONFIG - the two repos never
// import from each other (same convention as DEFAULT_CHANNEL_SETTINGS <-> defaultChannelConfig.json).
// A missing document must render a usable form rather than a page of blanks, and must leave the
// bot switched off rather than guessing a budget.
const DEFAULT_AI_CONFIG = {
  // Master switch. Starts off: the feature spends money, so it has to be turned on deliberately
  // once the persona and the limits have actually been looked at.
  enabled: false,
  model: "claude-haiku-4-5",
  // Requests per day across ALL channels, not per channel. This is the real brake on spend - the
  // filter matches on exact text, so for the first weeks it lets nearly everything through.
  dailyRequestLimit: 200,
  // Per-channel gap between two AI replies. Deliberately its own knob rather than reusing
  // commands.directmsg.cooldownMs: that one means "don't repeat the same brush-off", this one
  // means "don't burn the budget and don't flood chat" - tuning one must not move the other.
  cooldownMs: 15000,
  timeoutSeconds: 600,
  // "observe" writes what it WOULD have done to the log and times nobody out; "enforce" acts.
  // Starts in observe so the decision to enforce can be made from real cases - the same staging
  // the solo-game anti-cheat used.
  punishMode: "observe",
  // Hard ceiling on one call. A chat answer that arrives late is worse than none, so the budget
  // is small and there are no SDK retries behind it.
  requestTimeoutMs: 8000,
  memoryPairs: 5,
  memoryTtlDays: 30,
  // Whether the bot may add to the memory on its own. Off leaves the memory in place and still
  // read - it only stops new rows being written from chat.
  memoryEnabled: true,
  // How many remembered facts a channel may HOLD, and how many of them ride along with one
  // question. Two numbers rather than one because the bot no longer sends the whole memory: it
  // picks the facts whose words match what was asked (TwitchBot/shared/memoryRecall.js), so the
  // store can grow without the bill growing with it. Only the second number is spend.
  //
  // ONE store, not two. Facts about the channel and facts about its viewers live in the same
  // list and are selected the same way; the separate viewer memory, its cross-channel pool and
  // the relationship scale that gated who was allowed to write into it are all gone.
  memoryMax: 200,
  memoryRecall: 10,
  persona: "",
  // Правила целиком, если их переписали здесь. Пусто - работают встроенные из кода бота
  // (games/aiReply.js): настройка, которую не заполняли, не может означать «без правил».
  systemPrompt: "",
  // Текст встроенных правил, каким он есть в коде бота ПРЯМО СЕЙЧАС. Пишет его сам бот при
  // запуске, панель только читает и никогда не сохраняет обратно из формы: держать вторую копию
  // двух страниц прозы в этом репозитории значило бы синхронизировать её вручную, а расходится
  // такая копия молча.
  builtinSystemPrompt: "",
  updatedAt: null,
  updatedBy: null,
};

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiConfig");
  return collection;
}

async function getConfig() {
  const col = await ensureInitialized();
  const doc = await col.findOne({ _id: "global" });
  return { ...DEFAULT_AI_CONFIG, ...(doc || {}) };
}

async function saveConfig(patch, updatedBy) {
  const col = await ensureInitialized();
  await col.updateOne(
    { _id: "global" },
    { $set: { ...patch, updatedAt: new Date(), updatedBy: String(updatedBy) } },
    { upsert: true }
  );
  return getConfig();
}

module.exports = { DEFAULT_AI_CONFIG, getConfig, saveConfig };
