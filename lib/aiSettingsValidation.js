// Parsing and bounds for the AI mention-reply settings - the global document (db/aiConfigRepo.js)
// and the per-channel block (channelConfigRepo.saveAiConfig).
//
// Extracted from the route for the usual reason in this repo: rules that deserve a test do not
// live inside a request handler. The bounds themselves are the interesting part - most of them
// exist because the value on the other side of them costs money or reaches chat.
const MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];
const PUNISH_MODES = ["observe", "enforce"];

const MAX_PERSONA_LEN = 4000;
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
    persona: trimTo(body.persona, MAX_PERSONA_LEN),
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
