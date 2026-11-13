// Writes the summary printed on the Amnesty Bureau desk's fourth sheet: one model call, one short
// sheet - what the applicant was punished for, the arguments for and against lifting it, at most two
// log lines, an optional P.S. and a one-line impression. Called by routes/unbanBureau.js, both for a
// single case (the button on the sheet) and for the whole queue ("ИИ-обзор для всех",
// lib/unbanSummaryBatch.js).
//
// IT REPLACED A HEARING. Until 2026-11 this file ran a prosecutor/advocate transcript: two speeches
// per press, with a moderator able to buy more of them. The speeches were good and too long - a desk
// is where a moderator wants the case in half a minute, and it got two thousand characters per
// side. Those hearings are still on prod and still rendered (lib/unbanOpinionsValidation.js's
// toSheet), but nothing here continues them.
//
// THIS IS WHERE THE SITE PAYS FOR TOKENS, AND GOOGLE GOES FIRST BECAUSE OF WHO PAYS. Gemini's free
// tier is bounded by request count rather than money, so a summary written there costs nothing at
// all; Anthropic is the fallback and only writes a sheet Google failed to. The price of the free
// tier is not zero in every sense: Google trains on what is sent, and what is sent here is an
// applicant's chat log, the channel's rules and its moderators' names.
//
// WHY THESE TWO MODELS. Measured 2026-08-30 for the hearing, on three real briefs: gemini-3.5-flash
// argues from the log and quotes it accurately; gemini-3.5-flash-lite invented a material fact on
// the first case it was given; gemini-3.6-flash is as accurate and 3-4x slower. On the Anthropic
// side Haiku 4.5 came out dearer than Sonnet 5 at medium effort ($0.0240 vs $0.0221 per case) while
// inventing a timeframe the dossier did not contain. A summary is one call where a hearing was two,
// so both figures roughly halve; the choice itself was about accuracy and is kept for that reason.
// Re-measure before changing either.
//
// Failing is the ordinary Google outcome, not a rare one: 503 "high demand" on about 1 call in 15,
// plus a 429 once the free tier's request quota runs out - and that quota is a reading in AI
// Studio, not a number in our code. That is what the Anthropic fallback is for. There is no second
// Google attempt: the single-case button has a moderator waiting, and the batch has its own pace.
//
// STRUCTURED OUTPUT, NOT PROSE. One forced tool call returns the fields, the same contract
// TwitchBot/games/aiReply.js uses for chat replies. The field MECHANICS live here and in
// lib/unbanOpinionsValidation.js's parseSummary; the field POLICY - what counts as an argument, the
// tone, the taboo topics - lives in config/amnestyPrompts/summary.md. Same split as ../CLAUDE.md's
// "Rules are config too, guarantees are code".
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { parseSummary, SUMMARY_LIMITS } = require("./unbanOpinionsValidation");

const PROMPT_DIR = path.join(__dirname, "../config/amnestyPrompts");

// Read once at boot rather than per request: it is small, it never changes at runtime, and a
// missing file should stop the process rather than surface as a failed button press hours later.
const PROMPT = fs.readFileSync(path.join(PROMPT_DIR, "summary.md"), "utf8").trim();

const MODEL = "claude-sonnet-5";
const EFFORT = "medium";

const GOOGLE_MODEL = "gemini-3.5-flash";
// Thinking is what kept the hearing's speeches inside the case as well as inside their ceiling;
// kept at the same level for a call that has to judge which arguments the dossier supports.
const GOOGLE_THINKING_LEVEL = "low";
const GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// The point of a ceiling at all is that a hung socket eventually falls through to Anthropic instead
// of holding the moderator's button, or the batch, open forever.
const GOOGLE_TIMEOUT_MS = 90 * 1000;

// Thinking and the answer share this ceiling on both vendors, and running out is SILENT - the API
// returns a message with no tool call in it at all, not an error. A summary needs a few hundred
// tokens; the headroom is for the thinking.
const MAX_TOKENS = 8000;

// ── THE FIELDS ──────────────────────────────────────────────────────────────────────────────────
//
// Written in Anthropic's form and translated for Google below, exactly as TwitchBot/games/
// aiProvider.js does it. EVERY FIELD IS REQUIRED and "nothing to say" is an empty string or list:
// strict mode does not allow optional properties, and an absent key and a deliberately empty one
// would otherwise be indistinguishable at the far end.
//
// The lengths are stated in the descriptions rather than as maxLength/maxItems: strict tool schemas
// on the Anthropic side accept only a narrow subset of JSON Schema constraints, and a refused schema
// is a failed call on every case. The descriptions are what usually works; parseSummary's caps are
// what always works.
const TOLD = {
  reason: SUMMARY_LIMITS.reason - 60,
  point: SUMMARY_LIMITS.point - 50,
  points: SUMMARY_LIMITS.points,
  quotes: SUMMARY_LIMITS.quotes,
  ps: SUMMARY_LIMITS.ps - 50,
  verdict: SUMMARY_LIMITS.verdict - 30,
};

const SUMMARY_TOOL = {
  name: "summary",
  description:
    "Сдать краткую сводку по делу: за что наказан заявитель, доводы за и против разбана. " +
    "Это единственный способ ответить.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          `За что заявитель наказан, одной-двумя фразами, до ${TOLD.reason} знаков. Пункт правил ` +
          "канала, если поступок под него подпадает. Если причина неизвестна, так и написать.",
      },
      for: {
        type: "array",
        items: { type: "string" },
        description:
          `Доводы ЗА разбан, которые есть в досье: до ${TOLD.points} пунктов, каждый одной фразой ` +
          `до ${TOLD.point} знаков. Пустой список, если таких нет.`,
      },
      against: {
        type: "array",
        items: { type: "string" },
        description:
          `Доводы ПРОТИВ разбана, которые есть в досье: до ${TOLD.points} пунктов, каждый одной ` +
          `фразой до ${TOLD.point} знаков. Пустой список, если таких нет.`,
      },
      quotes: {
        type: "array",
        items: { type: "string" },
        description:
          `До ${TOLD.quotes} строк заявителя ДОСЛОВНО из досье, можно со временем: «14:02 — текст». ` +
          "Пустой список, если цитаты не нужны или тема табуированная.",
      },
      ps: {
        type: "string",
        description:
          `Необязательная приписка до ${TOLD.ps} знаков: одна деталь, которую модератор иначе ` +
          "пропустит. Пустая строка, если её нет.",
      },
      verdict: {
        type: "string",
        description:
          `Одна строка до ${TOLD.verdict} знаков: куда склоняется досье. Наблюдение, а не решение ` +
          "и не указание модератору.",
      },
    },
    required: ["reason", "for", "against", "quotes", "ps", "verdict"],
    additionalProperties: false,
  },
};

// Google accepts only a subset of OpenAPI: `strict` and `additionalProperties` are unknown to it,
// and an unknown schema key is a request ERROR rather than a warning. Types are upper-cased. Same
// translation as TwitchBot/games/aiProvider.js's toGoogleSchema() - a hand-kept copy, because the
// two repos never require() each other (see ../CLAUDE.md's hand-synced table) and this is the wire
// format knowledge, not application logic.
function toGoogleSchema(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" || key === "strict") continue;
    if (key === "type") out.type = String(value).toUpperCase();
    else if (key === "items") out.items = toGoogleSchema(value);
    else if (key === "properties") {
      out.properties = {};
      for (const [name, sub] of Object.entries(value)) out.properties[name] = toGoogleSchema(sub);
    } else out[key] = value;
  }
  return out;
}

// The whole length budget said once more, in the system prompt: the field descriptions carry the
// per-field numbers, this carries the point of them. The hearing learnt that a model told nothing
// about length writes as much as it likes (Gemini wrote 1850-2190 characters a speech unprompted),
// and that a ceiling stated in the system prompt holds better than one appended to the turn.
const LENGTH_RULE =
  "\n\nДЛИНА: сводку читают за полминуты. Каждое поле — в пределах, указанных в его описании; " +
  `доводов не больше ${TOLD.points} с каждой стороны. Слишком длинная сводка будет отклонена целиком.`;

class OpinionsGenerationError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "OpinionsGenerationError";
    this.reason = reason;
  }
}

// `fields` being null is the case worth spelling out: the call FORCES the tool, so fields are the
// expected shape of the answer - but a refusal and a run into the token ceiling both arrive as an
// ordinary 200 carrying no tool call whatsoever. Checked rather than assumed, because otherwise
// that failure is silent.
function checkedFields(fields, stopReason) {
  if (!fields || typeof fields !== "object") {
    throw new OpinionsGenerationError("empty_summary", `no tool call (stop reason: ${stopReason})`);
  }
  return fields;
}

// --- Anthropic ----------------------------------------------------------------------------------

/**
 * Wraps an Anthropic SDK client as a writer. Injected rather than built here so this file is
 * testable without a key or a network - see tests/unbanOpinionsGenerator.test.js.
 */
function anthropicWriter(client) {
  return {
    vendor: "anthropic",
    model: MODEL,
    effort: EFFORT,
    async write(system, userText) {
      let res;
      try {
        res = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: system + LENGTH_RULE,
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT },
          // Forcing the tool alongside adaptive thinking is allowed on the first-party API; only
          // Bedrock requires thinking to be off for a forced tool_choice, and this app talks to the
          // API directly. `strict` rides on the tool definition itself, never on tool_choice.
          tools: [SUMMARY_TOOL],
          tool_choice: { type: "tool", name: SUMMARY_TOOL.name },
          messages: [{ role: "user", content: userText }],
        });
      } catch (err) {
        // Upstream trouble (rate limit, overload, bad key) is its own reason so the button can say
        // "try again" rather than "the case is broken" - nothing about the case caused it.
        throw new OpinionsGenerationError("upstream", err && err.message ? err.message : String(err));
      }

      // A refusal arrives as a normal 200 with no usable content, so it has to be checked before
      // the answer is read rather than after.
      if (res.stop_reason === "refusal") {
        throw new OpinionsGenerationError("refused", "safety classifier declined the request");
      }

      const call = (res.content || []).find((block) => block.type === "tool_use");
      const usage = res.usage || {};
      return {
        fields: checkedFields(call ? call.input : null, res.stop_reason),
        usage: {
          inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0),
          outputTokens: usage.output_tokens || 0,
        },
      };
    },
  };
}

// --- Google -------------------------------------------------------------------------------------

// Everything Google refuses arrives as a normal 200: a blocked prompt comes back with no candidates
// at all, a blocked answer as a candidate carrying a safety finishReason and no content.
const GOOGLE_REFUSAL_FINISHES = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

/**
 * Wraps a Gemini key as a writer. `post` is injected for the same reason the Anthropic client is:
 * this file's tests must not need a key or a network.
 *
 * @param {object}    params
 * @param {string}    params.apiKey
 * @param {function} [params.post]  axios-shaped (url, body, config) => {data}
 */
function googleWriter({ apiKey, post = axios.post }) {
  return {
    vendor: "google",
    model: GOOGLE_MODEL,
    effort: `thinking ${GOOGLE_THINKING_LEVEL}`,
    async write(system, userText) {
      let res;
      try {
        res = await post(
          `${GOOGLE_ENDPOINT}/${encodeURIComponent(GOOGLE_MODEL)}:generateContent`,
          {
            systemInstruction: { parts: [{ text: system + LENGTH_RULE }] },
            contents: [{ role: "user", parts: [{ text: userText }] }],
            tools: [
              {
                functionDeclarations: [
                  {
                    name: SUMMARY_TOOL.name,
                    description: SUMMARY_TOOL.description,
                    parameters: toGoogleSchema(SUMMARY_TOOL.input_schema),
                  },
                ],
              },
            ],
            // ANY is Google's spelling of "you must call one of these", and naming the only tool
            // makes it the forced equivalent of Anthropic's tool_choice above.
            toolConfig: {
              functionCallingConfig: { mode: "ANY", allowedFunctionNames: [SUMMARY_TOOL.name] },
            },
            generationConfig: {
              maxOutputTokens: MAX_TOKENS,
              thinkingConfig: { thinkingLevel: GOOGLE_THINKING_LEVEL },
            },
          },
          {
            timeout: GOOGLE_TIMEOUT_MS,
            // Key in a header rather than as ?key= like the documentation's examples: the request
            // URL ends up inside axios's own error text and in any log line next to it, and a key
            // does not belong there.
            headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          }
        );
      } catch (err) {
        // The free tier answers 503 "high demand" often enough that this is the ordinary way to the
        // next vendor rather than an exceptional one.
        throw new OpinionsGenerationError("upstream", err && err.message ? err.message : String(err));
      }

      const data = (res && res.data) || {};
      if (data.promptFeedback && data.promptFeedback.blockReason) {
        throw new OpinionsGenerationError("refused", `prompt blocked: ${data.promptFeedback.blockReason}`);
      }

      const candidate = (data.candidates || [])[0] || {};
      if (GOOGLE_REFUSAL_FINISHES.has(candidate.finishReason)) {
        throw new OpinionsGenerationError("refused", `blocked: ${candidate.finishReason}`);
      }

      const parts = (candidate.content && candidate.content.parts) || [];
      const call = parts.find((part) => part.functionCall && part.functionCall.name === SUMMARY_TOOL.name);

      const usage = data.usageMetadata || {};
      return {
        fields: checkedFields(call ? call.functionCall.args : null, candidate.finishReason),
        usage: {
          // Google's promptTokenCount INCLUDES the cached prefix where Anthropic's input_tokens
          // excludes it, so the cached part comes off here and one accounting covers both.
          inputTokens: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
          // Thinking bills as output and arrives as its own field; not adding it under-reports.
          outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        },
      };
    },
  };
}

/**
 * The vendors this deployment can write with, in the order they are tried.
 *
 * Google first is the whole policy of this module. A vendor with no key configured is absent from
 * the list rather than a failing entry in it - an empty list is what the route turns into "this
 * feature is not configured on this server".
 *
 * @param {object}   params
 * @param {object?}  params.anthropic  an Anthropic SDK client, or null if no key is configured
 * @param {object?}  params.google     `{apiKey, post?}`, or null if no key is configured
 */
function buildWriters({ anthropic = null, google = null } = {}) {
  const writers = [];
  if (google && google.apiKey) writers.push(googleWriter(google));
  if (anthropic) writers.push(anthropicWriter(anthropic));
  return writers;
}

// What follows the dossier in the user turn. Short on purpose: the policy is in the system prompt,
// and this only says what is being asked of this one brief.
const INSTRUCTION = "Составь сводку по этому делу.";

/**
 * Writes the summary for one case, on the first vendor that produces a valid one.
 *
 * Validation happens HERE, per vendor, not after the loop: a Google answer that came back without a
 * reason, or ran away, is a failure of that vendor and the next one gets the case - checking only
 * the winner would turn a fixable answer into a failed press.
 *
 * @param {object}   params
 * @param {object[]} params.writers  from buildWriters(), ordered cheapest-first
 * @param {string}   params.brief    the plain-text dossier, from unbanDossierRepo.getCaseBrief()
 * @returns {Promise<{summary: object, vendor: string, model: string, effort: string,
 *                    usage: {inputTokens: number, outputTokens: number}}>}
 *          `summary` is parseSummary()'s value, ready for db/unbanOpinionsRepo.js's upsertSummary.
 */
async function generateSummary({ writers, brief }) {
  if (!brief || !String(brief).trim()) {
    throw new OpinionsGenerationError("empty_brief", "brief is empty");
  }
  if (!writers || !writers.length) {
    throw new OpinionsGenerationError("no_vendor", "no model vendor is configured");
  }

  let last = null;
  for (const writer of writers) {
    try {
      const written = await writer.write(PROMPT, `${brief}\n\n${INSTRUCTION}`);
      const parsed = parseSummary(written.fields, { model: writer.model, vendor: writer.vendor });
      if (!parsed.ok) throw new OpinionsGenerationError(parsed.reason, `rejected: ${parsed.reason}`);
      return {
        summary: parsed.value,
        vendor: writer.vendor,
        model: writer.model,
        effort: writer.effort,
        usage: written.usage,
      };
    } catch (err) {
      if (!(err instanceof OpinionsGenerationError)) throw err;
      last = err;
      // Logged even when the next vendor saves the case: a Google side that has quietly started
      // failing every time is invisible otherwise - the sheet still appears, and the bill is the
      // only other place it shows.
      console.warn(`[opinions] ${writer.vendor} (${writer.model}) failed: ${err.reason} - ${err.message}`);
    }
  }
  throw last;
}

module.exports = {
  generateSummary,
  buildWriters,
  OpinionsGenerationError,
  MODEL,
  EFFORT,
  GOOGLE_MODEL,
  MAX_TOKENS,
  SUMMARY_TOOL,
  // exported for the unit tests
  _internal: {
    PROMPT,
    anthropicWriter,
    googleWriter,
    LENGTH_RULE,
    toGoogleSchema,
    TOLD,
  },
};
