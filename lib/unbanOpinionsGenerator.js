// Runs the two-turn hearing that fills the Amnesty Bureau desk's fourth sheet: the prosecutor
// accuses, the advocate answers, and that is the whole session. Called by routes/unbanBureau.js's
// "заказать разбор" button.
//
// THIS IS WHERE THE SITE STARTED PAYING FOR TOKENS. Until 2026-08-11 the speeches were produced by
// Claude Code running two subagents by hand and PUT through the admin API, and both CLAUDE.md files
// stated outright that this app never calls Anthropic. That is no longer true, and the reason it
// changed is worth keeping: the ~$1-per-case figure that justified the manual route turned out to be
// the Claude Code harness (a full tool-describing system prompt, three times over), not the model.
// The same prompts through the plain Messages API cost about two cents.
//
// TWO VENDORS, AND GOOGLE GOES FIRST BECAUSE OF WHO PAYS. Gemini's free tier is bounded by request
// count rather than money, so a hearing written there costs nothing at all; Anthropic is the
// fallback and only writes a sheet Google failed to. That order is the whole point of the split -
// the hearing itself is identical either way, and the stored `model` says which vendor wrote it.
// The price of the free tier is not zero in every sense: Google trains on what is sent, and what is
// sent here is an applicant's chat log, the channel's rules and its moderators' names.
//
// A VENDOR IS RETRIED AT THE LEVEL OF THE WHOLE HEARING, NOT THE TURN. A prosecutor written by one
// model and an advocate by another is a sheet whose provenance field is a lie, and the advocate
// answers the accusation directly - it has to be answering the one on the page. The cost of that is
// a redone prosecutor turn when Google fails on the second one; that turn was free.
//
// WHY THESE TWO MODELS. Measured 2026-08-30 on three real briefs (onecrippled, taffik, zeradyf)
// against the sheets already on prod:
//   - gemini-3.5-flash argues from the log, quotes it accurately and stays inside the case. It
//     infers no length at all from the prompts, though - 1850-2190 characters unprompted - so the
//     ceiling is stated outright (LENGTH_RULE below), and it then writes to the number it is
//     given: 850-990 when asked for 1000, 1350-1724 when asked for 1800.
//   - gemini-3.5-flash-lite (what the bot uses for chat replies) is not used here. It fits the cap
//     unprompted but invented a material fact on the first case it was given, putting the
//     applicant's 1-year-2-month appeal delay between the offence and the ban instead. This feature
//     has been burned by exactly that class of error before - see the three-turn measurement below.
//   - gemini-3.6-flash is as accurate and 3-4x slower (10-44s a turn against 4-9s), for a sheet a
//     moderator is waiting on. Not worth the wait; revisit if 3.5-flash regresses.
// Failing is the ordinary Google outcome, not a rare one: 503 "high demand" on 1 call in 15 on
// gemini-3.5-flash and on every single attempt at the newest model in the family, plus a 429 once
// the free tier's request quota runs out - and that quota is a reading, it lives in AI Studio, not
// here. That is what the Anthropic fallback is for, and why there is no retry against Google
// first: the moderator is waiting, and a second free attempt spends their time rather than our
// money.
//
// WHY SONNET 5 ON THE ANTHROPIC SIDE AND NOT A CHEAPER MODEL. Measured on three real cases, not
// assumed. Haiku 4.5 has no `effort` parameter at all, so thinking depth can only be bought with a
// fixed `budget_tokens`, and a budget large enough to produce a usable speech cost MORE per case
// than Sonnet 5's adaptive thinking at medium effort ($0.0240 vs $0.0221) - while inventing a
// timeframe the dossier does not contain ("46 mutes in two months" against counters explicitly
// scoped to the channel's lifetime). Cheaper model, dearer and worse. Revisit only with a fresh
// measurement.
//
// TWO TURNS, NOT THREE, AND THE ADVOCATE HAS THE LAST WORD. The old third turn let the prosecutor
// revise; it was dropped because it did not do the job it was kept for. On the three-case control
// the three-turn transcripts carried a material factual error in two of them, both favouring the
// defence, and in both the prosecutor's "audit" turn conceded to the fabrication rather than
// catching it. Losing that turn costs nothing measurable and halves the calls.
//
// The advocate's prompt is deliberately the looser of the two (see config/amnestyPrompts/): real
// appeals are written badly, so a defence bound to the applicant's own framing loses on the
// applicant's writing rather than on the case. Only the no-invented-facts rule is left on it.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { MAX_OPINION_CHARS } = require("./unbanOpinionsValidation");

const PROMPT_DIR = path.join(__dirname, "../config/amnestyPrompts");

// Read once at boot rather than per request: these are small, they never change at runtime, and a
// missing file should stop the process rather than surface as a failed button press hours later.
const PROMPTS = {
  prosecutor: fs.readFileSync(path.join(PROMPT_DIR, "prosecutor.md"), "utf8").trim(),
  advocate: fs.readFileSync(path.join(PROMPT_DIR, "advocate.md"), "utf8").trim(),
};

const MODEL = "claude-sonnet-5";
const EFFORT = "medium";

const GOOGLE_MODEL = "gemini-3.5-flash";
// Thinking is what keeps the speeches inside the ceiling as well as inside the case: with no
// thinkingConfig at all the same model wrote past the cap on every measured brief.
const GOOGLE_THINKING_LEVEL = "low";
const GOOGLE_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// Generous, because a slow speech is still a usable one and the page already expects tens of
// seconds. The point of having a ceiling at all is that a hung socket eventually falls through to
// Anthropic instead of holding the moderator's button open forever.
const GOOGLE_TIMEOUT_MS = 90 * 1000;

// The sheet's length cap, said out loud. Neither prompt file states a length - "длина по делу" is
// deliberate there - and the ceiling lived only in the validator, where a speech that overran it
// became a failed press with a blank sheet. That is not hypothetical for either vendor: Gemini
// wrote 1850-2190 characters unprompted, and Sonnet, whose speeches usually land at 760-1190, came
// back with 1349 on the very first brief the fallback was tested against. So both are told, and in
// the system prompt rather than the turn - appended to the turn, Gemini's speeches got LONGER.
//
// The number told is NOT the cap: a model given its exact limit overshoots it by a little, and the
// margin is what makes that overshoot still fit. Derived rather than written out, so raising the
// cap raises what the models are asked for instead of silently tightening the squeeze on them -
// the point of the ceiling is to catch a model that has run away, not to compress a speech that
// has something to say. The instruction is what usually works; the guarantee is still
// lib/unbanOpinionsValidation.js, which rejects an over-long speech whoever wrote it.
const TOLD_MAX_CHARS = MAX_OPINION_CHARS - 200;
const LENGTH_RULE =
  `\n\nЖЁСТКИЙ ПРЕДЕЛ ДЛИНЫ: не больше ${TOLD_MAX_CHARS} знаков. Речь длиннее будет отклонена ` +
  "целиком — уложись в этот предел, чего бы это ни стоило.";

// Thinking and the reply share this ceiling, so it is set well clear of what a 2-4 sentence speech
// needs. Measured runs land near 1.5k output tokens including thinking; the headroom exists because
// running out is silent on both vendors - the API returns a message with no text block at all, not
// an error. That is not hypothetical: at a tighter ceiling a long brief produced an empty speech
// with stop_reason "max_tokens", which is why emptiness is checked explicitly below.
const MAX_TOKENS = 8000;

class OpinionsGenerationError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "OpinionsGenerationError";
    this.reason = reason;
  }
}

// A speech longer than the sheet holds is a failed turn, not a stored document: the same ceiling is
// checked again in lib/unbanOpinionsValidation.js, and reaching it there means the moderator gets a
// 502 with a blank sheet even though the other vendor would have fitted. Checked on the raw text
// because that validator's clean() only ever removes characters - what passes here passes there.
function checkedSpeech(text, stopReason) {
  if (!text) {
    throw new OpinionsGenerationError("empty_speech", `no text (stop reason: ${stopReason})`);
  }
  if (text.length > MAX_OPINION_CHARS) {
    throw new OpinionsGenerationError(
      "too_long",
      `${text.length} chars against a ceiling of ${MAX_OPINION_CHARS}`
    );
  }
  return text;
}

// --- Anthropic ----------------------------------------------------------------------------------

/**
 * Wraps an Anthropic SDK client as a speaker. Injected rather than built here so the hearing is
 * testable without a key or a network - see tests/unbanOpinionsGenerator.test.js.
 */
function anthropicSpeaker(client) {
  return {
    vendor: "anthropic",
    model: MODEL,
    effort: EFFORT,
    async speak(system, userText) {
      let res;
      try {
        res = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: system + LENGTH_RULE,
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT },
          messages: [{ role: "user", content: userText }],
        });
      } catch (err) {
        // Upstream trouble (rate limit, overload, bad key) is reported as its own reason so the
        // button can say "try again" rather than "the case is broken" - nothing about the case
        // caused it.
        throw new OpinionsGenerationError("upstream", err && err.message ? err.message : String(err));
      }

      // A refusal arrives as a normal 200 with an empty content array, so it has to be checked
      // before the text is read rather than after.
      if (res.stop_reason === "refusal") {
        throw new OpinionsGenerationError("refused", "safety classifier declined the request");
      }

      const text = res.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      const usage = res.usage || {};
      return {
        text: checkedSpeech(text, res.stop_reason),
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
// at all, a blocked answer as a candidate carrying a safety finishReason and no text.
const GOOGLE_REFUSAL_FINISHES = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

/**
 * Wraps a Gemini key as a speaker. `post` is injected for the same reason the Anthropic client is:
 * this file's tests must not need a key or a network.
 *
 * @param {object}    params
 * @param {string}    params.apiKey
 * @param {function} [params.post]  axios-shaped (url, body, config) => {data}
 */
function googleSpeaker({ apiKey, post = axios.post }) {
  return {
    vendor: "google",
    model: GOOGLE_MODEL,
    effort: `thinking ${GOOGLE_THINKING_LEVEL}`,
    async speak(system, userText) {
      let res;
      try {
        res = await post(
          `${GOOGLE_ENDPOINT}/${encodeURIComponent(GOOGLE_MODEL)}:generateContent`,
          {
            systemInstruction: { parts: [{ text: system + LENGTH_RULE }] },
            contents: [{ role: "user", parts: [{ text: userText }] }],
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
        throw new OpinionsGenerationError(
          "refused",
          `prompt blocked: ${data.promptFeedback.blockReason}`
        );
      }

      const candidate = (data.candidates || [])[0] || {};
      if (GOOGLE_REFUSAL_FINISHES.has(candidate.finishReason)) {
        throw new OpinionsGenerationError("refused", `blocked: ${candidate.finishReason}`);
      }

      const parts = (candidate.content && candidate.content.parts) || [];
      const text = parts
        // Thinking arrives as text parts too, marked `thought`. It is a draft of the reasoning, not
        // a speech, and printing it on the sheet would be printing the model's notes.
        .filter((part) => typeof part.text === "string" && !part.thought)
        .map((part) => part.text)
        .join("")
        .trim();

      const usage = data.usageMetadata || {};
      return {
        text: checkedSpeech(text, candidate.finishReason),
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
 * The vendors this deployment can hold a hearing with, in the order they are tried.
 *
 * Google first is the whole policy of this module: a free-tier hearing costs nothing, so Anthropic
 * should only ever write a sheet Google failed to write. A vendor with no key configured is absent
 * from the list rather than a failing entry in it - an empty list is what the route turns into
 * "this feature is not configured on this server".
 *
 * @param {object}   params
 * @param {object?}  params.anthropic  an Anthropic SDK client, or null if no key is configured
 * @param {object?}  params.google     `{apiKey, post?}`, or null if no key is configured
 */
function buildSpeakers({ anthropic = null, google = null } = {}) {
  const speakers = [];
  if (google && google.apiKey) speakers.push(googleSpeaker(google));
  if (anthropic) speakers.push(anthropicSpeaker(anthropic));
  return speakers;
}

async function holdHearing(speaker, brief) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = (u) => {
    usage.inputTokens += u.inputTokens || 0;
    usage.outputTokens += u.outputTokens || 0;
  };

  const accusation = await speaker.speak(
    PROMPTS.prosecutor,
    `${brief}\n\nТы ходишь первым. Предъяви обвинение.`
  );
  count(accusation.usage);

  // The advocate gets the brief again rather than only the accusation: it argues from the dossier,
  // not from the prosecutor's summary of it, and being able to check a quoted line against the log
  // is most of what its one rule is for.
  const defence = await speaker.speak(
    PROMPTS.advocate,
    `${brief}\n\n[ОБВИНЕНИЕ ПРОКУРОРА]\n${accusation.text}\n\nОтвечай.`
  );
  count(defence.usage);

  return {
    prosecutor: { opening: accusation.text },
    advocate: { opening: defence.text },
    vendor: speaker.vendor,
    model: speaker.model,
    effort: `${speaker.effort} / 2 хода`,
    usage,
  };
}

/**
 * Holds the hearing for one case, on the first vendor that manages it.
 *
 * @param {object}   params
 * @param {object[]} params.speakers  from buildSpeakers(), ordered cheapest-first
 * @param {string}   params.brief     the plain-text dossier, from unbanDossierRepo.getCaseBrief()
 * @returns {Promise<{prosecutor: {opening: string}, advocate: {opening: string}, vendor: string,
 *                    model: string, effort: string,
 *                    usage: {inputTokens: number, outputTokens: number}}>}
 *          Shaped for lib/unbanOpinionsValidation.js's parseOpinions(), which derives `final` and
 *          `decision` from it - a two-turn hearing has no second move, so `decision` lands on
 *          "silent" without anything here having to say so.
 */
async function generateOpinions({ speakers, brief }) {
  if (!brief || !String(brief).trim()) {
    throw new OpinionsGenerationError("empty_brief", "brief is empty");
  }
  if (!speakers || !speakers.length) {
    throw new OpinionsGenerationError("no_vendor", "no model vendor is configured");
  }

  let last = null;
  for (const speaker of speakers) {
    try {
      return await holdHearing(speaker, brief);
    } catch (err) {
      if (!(err instanceof OpinionsGenerationError)) throw err;
      last = err;
      // Logged even when the next vendor saves the press: a Google side that has quietly started
      // failing every time is invisible otherwise - the sheet still appears, and the bill is the
      // only other place it shows.
      console.warn(
        `[opinions] ${speaker.vendor} (${speaker.model}) failed: ${err.reason} - ${err.message}`
      );
    }
  }
  throw last;
}

module.exports = {
  generateOpinions,
  buildSpeakers,
  OpinionsGenerationError,
  MODEL,
  EFFORT,
  GOOGLE_MODEL,
  MAX_TOKENS,
  // exported for the unit tests
  _internal: { PROMPTS, anthropicSpeaker, googleSpeaker, LENGTH_RULE },
};
