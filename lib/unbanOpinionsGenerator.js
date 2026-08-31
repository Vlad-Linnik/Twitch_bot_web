// Runs the hearing printed on the Amnesty Bureau desk's fourth sheet. Two entry points, and the
// difference between them is the whole design of this file: generateOpinions() OPENS a hearing
// (prosecutor accuses, advocate answers), and generateTurn() adds ONE more speech to a hearing that
// already exists, because the moderator pressed "передать слово". Called by routes/unbanBureau.js.
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
// RETRY GRANULARITY DIFFERS BETWEEN THE TWO ENTRY POINTS, AND THAT IS NOT AN INCONSISTENCY.
// generateOpinions() retries the WHOLE hearing on the next vendor: it produces two speeches in one
// press, the advocate answers the accusation directly, and a sheet whose two halves were written by
// different models is a sheet whose provenance field is a lie. generateTurn() retries the SINGLE
// turn, because by then every earlier speech is already stored and on the page - the replacement
// answers the same transcript the failed attempt did, so nothing can disagree. The old whole-hearing
// rule applied to a later turn would mean re-arguing, and re-charging for, speeches the moderator
// has already read.
//
// STRUCTURED OUTPUT, NOT PROSE. The speeches used to come back as one flat string. They come back as
// FIELDS now - rule, headline, speech, quotes, demand, counter - through a forced tool call, the
// same contract TwitchBot/games/aiReply.js uses for chat replies. The reason is what the sheet does
// with them rather than what the model does with them: "which rule point", "what is being asked
// for" and "which log lines" were the three things a moderator scanned every speech to find, and
// finding them meant reading a paragraph to the end. As fields they are a chip, a line and a block,
// each coloured, and the speech is left to be an argument instead of a container for metadata.
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
// THE OPENING IS TWO TURNS, NOT THREE, AND THE ADVOCATE HAS THE LAST WORD OF IT. The old third turn
// let the prosecutor revise; it was dropped because it did not do the job it was kept for. On the
// three-case control the three-turn transcripts carried a material factual error in two of them,
// both favouring the defence, and in both the prosecutor's "audit" turn conceded to the fabrication
// rather than catching it. Losing that turn costs nothing measurable and halves the calls. What
// replaced it is not a third automatic turn but a moderator who can ask for one - and who can say
// why, which is the part the automatic turn never had.
//
// The advocate's prompt is deliberately the looser of the two (see config/amnestyPrompts/): real
// appeals are written badly, so a defence bound to the applicant's own framing loses on the
// applicant's writing rather than on the case. Only the no-invented-facts rule is left on it.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { MAX_OPINION_CHARS, MAX_QUOTES } = require("./unbanOpinionsValidation");
const { stripMarkup } = require("../public/js/games/engines/speechMarkup");

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

// Thinking and the speech share this ceiling, so it is set well clear of what a few paragraphs
// need. Measured runs land near 1.5k output tokens including thinking; the headroom exists because
// running out is silent on both vendors - the API returns a message with no tool call in it at all,
// not an error. That is not hypothetical: at a tighter ceiling a long brief produced an empty speech
// with stop_reason "max_tokens", which is why emptiness is checked explicitly below.
const MAX_TOKENS = 8000;

// ── THE FIELDS ──────────────────────────────────────────────────────────────────────────────────
//
// One schema, written in Anthropic's form and translated for Google below, exactly as
// TwitchBot/games/aiProvider.js does it. Both sides of the hearing use the SAME tool: a prosecutor
// naming the rule it says was broken and an advocate naming the rule it says was not are the same
// move, and two near-identical schemas would drift the moment one of them was edited.
//
// EVERY FIELD IS REQUIRED, and "nothing to say" is an empty string or an empty list - strict mode
// does not allow optional properties, and an absent key and a deliberately empty one would
// otherwise be indistinguishable at the far end. `speech` is the only field whose emptiness is a
// failed turn.
//
// The field MECHANICS live here, in code. The field POLICY - what makes a good accusation, when to
// concede, what tone the case deserves - lives in config/amnestyPrompts/, where it can be edited
// without a deploy. Same split ../CLAUDE.md draws for the bot under "Rules are config too,
// guarantees are code", and for the same reason: what the parser depends on must not be editable
// prose, because its absence fails silently.
const SPEECH_TOOL = {
  name: "speech",
  description:
    "Выступить на заседании: назвать пункт правил, произнести речь и заявить требование. " +
    "Это единственный способ ответить - обычным текстом заседание не ведут.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      rule: {
        type: "string",
        description:
          "Пункт правил канала, о котором идёт речь: номер и короткое название, например " +
          "«пункт 3, оскорбления участников». Прокурор называет тот, который считает нарушенным; " +
          "Адвокат - тот, по которому обвиняют его подзащитного. Правила приведены в начале " +
          "досье. Пустая строка - только если дело вообще не сводится к пункту правил.",
      },
      headline: {
        type: "string",
        description:
          "Одна строка - суть твоего хода, как заголовок в деле: то, что модератор прочтёт, если " +
          "не станет читать речь целиком. Без точки в конце, без кавычек, не длиннее строки.",
      },
      speech: {
        type: "string",
        description:
          "Сама речь, по-русски. Абзацы разрешены. Одиночными звёздочками можно выделить то, на " +
          "чём держится довод: *вот так*. Выделяй скупо, два-три места на речь, иначе выделение " +
          "перестаёт что-либо значить. Никакой другой разметки: заголовки, списки, markdown и " +
          "решётки попадут на лист буквально, как ты их написал. Цитаты из лога сюда не " +
          "переписывай - для них есть поле quotes.",
      },
      quotes: {
        type: "array",
        items: { type: "string" },
        description:
          "Строки из лога, на которые ты опираешься, дословно из досье, до " + MAX_QUOTES +
          " штук. Каждая - одной строкой, можно со временем: «14:02 — текст». Сюда идёт только " +
          "то, что есть в деле: выдуманная цитата стоит человеку разбана. Пустой список, если " +
          "опоры на конкретные строки у тебя нет.",
      },
      demand: {
        type: "string",
        description:
          "Чего ты требуешь по итогам этого хода, одной строкой: «оставить бан навсегда», " +
          "«немедленная амнистия», «разбан через месяц». Требование к мере - это твоё право, а не " +
          "факт из дела, и правило про цифры только из досье на него не распространяется.",
      },
      counter: {
        type: "string",
        description:
          "Коротко: что противная сторона выдумала, натянула или приписала - домысел, выданный за " +
          "факт, ссылка на то, чего в деле нет, приписанное намерение. Пустая строка, если ты " +
          "ходишь первым или возражать не по чему.",
      },
    },
    required: ["rule", "headline", "speech", "quotes", "demand", "counter"],
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
//
// It names the FIELD now, not "the speech": with six fields coming back, an unqualified character
// limit reads as a budget for all of them together, and the first thing a model trims to meet a
// budget is the quotes that make the speech checkable.
const TOLD_MAX_CHARS = MAX_OPINION_CHARS - 200;
const LENGTH_RULE =
  `\n\nЖЁСТКИЙ ПРЕДЕЛ ДЛИНЫ: поле speech - не больше ${TOLD_MAX_CHARS} знаков. Речь длиннее ` +
  "будет отклонена целиком - уложись в этот предел, чего бы это ни стоило. На остальные поля " +
  "предел не распространяется, они и так короткие.";

class OpinionsGenerationError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "OpinionsGenerationError";
    this.reason = reason;
  }
}

// A turn with no speech in it is a failed turn, not a stored document, and so is one longer than the
// sheet holds: the same ceiling is checked again in lib/unbanOpinionsValidation.js, and reaching it
// there means the moderator gets a 502 with a blank sheet even though the other vendor would have
// fitted. Checked on the raw text because that validator's clean() only ever removes characters -
// what passes here passes there.
//
// `fields` being null at all is the case worth spelling out: the call FORCES the tool, so fields are
// the expected shape of the answer - but a refusal and a run into the token ceiling both arrive as
// an ordinary 200 carrying no tool call whatsoever. Checked rather than assumed, because otherwise
// that failure is silent.
function checkedFields(fields, stopReason) {
  if (!fields || typeof fields !== "object") {
    throw new OpinionsGenerationError("empty_speech", `no tool call (stop reason: ${stopReason})`);
  }
  const speech = typeof fields.speech === "string" ? fields.speech.trim() : "";
  if (!speech) {
    throw new OpinionsGenerationError("empty_speech", `empty speech (stop reason: ${stopReason})`);
  }
  if (speech.length > MAX_OPINION_CHARS) {
    throw new OpinionsGenerationError(
      "too_long",
      `${speech.length} chars against a ceiling of ${MAX_OPINION_CHARS}`
    );
  }
  return fields;
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
          // Forcing the tool alongside adaptive thinking is allowed on the first-party API; only
          // Bedrock requires thinking to be off for a forced tool_choice, and this app talks to the
          // API directly. `strict` rides on the tool definition itself, never on tool_choice.
          tools: [SPEECH_TOOL],
          tool_choice: { type: "tool", name: SPEECH_TOOL.name },
          messages: [{ role: "user", content: userText }],
        });
      } catch (err) {
        // Upstream trouble (rate limit, overload, bad key) is reported as its own reason so the
        // button can say "try again" rather than "the case is broken" - nothing about the case
        // caused it.
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
            tools: [
              {
                functionDeclarations: [
                  {
                    name: SPEECH_TOOL.name,
                    description: SPEECH_TOOL.description,
                    parameters: toGoogleSchema(SPEECH_TOOL.input_schema),
                  },
                ],
              },
            ],
            // ANY is Google's spelling of "you must call one of these", and naming the only tool
            // makes it the forced equivalent of Anthropic's tool_choice above.
            toolConfig: {
              functionCallingConfig: { mode: "ANY", allowedFunctionNames: [SPEECH_TOOL.name] },
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
      const call = parts.find((part) => part.functionCall && part.functionCall.name === SPEECH_TOOL.name);

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

// ── THE TRANSCRIPT ──────────────────────────────────────────────────────────────────────────────

const ROLE_LABELS = { prosecutor: "ПРОКУРОР", advocate: "АДВОКАТ", judge: "СУД" };

/**
 * Renders the hearing so far as the plain text a later speaker reads.
 *
 * It carries the FIELDS, not only the speeches. A turn is answered as a whole - a demand of "оставить
 * бан навсегда" is a thing to argue with, and a rule reference is what the other side either
 * disputes or concedes - so sending only `speech` would hide from each speaker the very parts of the
 * previous turn the sheet puts in front of the moderator.
 *
 * Emphasis markers come OFF here (public/js/games/engines/speechMarkup.js's stripMarkup). They are
 * how the sheet prints a speech, not part of what was said, and a speaker reading them back tends to
 * quote them - putting a literal asterisk into a quotes entry, which is then printed verbatim.
 *
 * Turn numbers are the list's own positions and are stated, because they are how the judge's remarks
 * and the speeches stay ordered relative to each other in the reader's mind.
 */
function renderTranscript(turns) {
  return (turns || [])
    .map((turn) => {
      const label = ROLE_LABELS[turn.role] || turn.role;
      if (turn.role === "judge") {
        const who = (turn.author && turn.author.displayName) || "модератор";
        return `[ход ${turn.n}] ${label} (${who}):\n${stripMarkup(turn.speech)}`;
      }
      const lines = [`[ход ${turn.n}] ${label}:`];
      if (turn.rule) lines.push(`Пункт правил: ${turn.rule}`);
      if (turn.headline) lines.push(`Тезис: ${turn.headline}`);
      lines.push(stripMarkup(turn.speech));
      if (turn.counter) lines.push(`Возражение: ${turn.counter}`);
      if (turn.quotes && turn.quotes.length) {
        lines.push(`Цитаты из лога: ${turn.quotes.map((q) => `«${q}»`).join("; ")}`);
      }
      if (turn.demand) lines.push(`Требование: ${turn.demand}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

// What the speaker is being asked to do this turn. The judge case is the reason this is a function
// rather than a constant: a remark the moderator typed is the one thing in the transcript that was
// written by a person with authority over the outcome, and a speaker that treats it as just another
// line above it answers everything except the question it was actually asked.
function turnInstruction(turns) {
  const list = turns || [];
  if (!list.length) return "Ты ходишь первым. Предъяви обвинение.";
  const last = list[list.length - 1];
  if (last && last.role === "judge") {
    return (
      "Тебе передали слово, и последним говорил СУД. Ответь на его слова первым делом, прямо и " +
      "по существу, и лишь затем продолжай заседание."
    );
  }
  return "Тебе передали слово. Отвечай на сказанное выше и продолжай заседание.";
}

function speakerPrompt(role) {
  return PROMPTS[role] || PROMPTS.prosecutor;
}

// One turn, on one vendor. The brief goes with EVERY turn rather than only the first: a speaker
// argues from the dossier, not from the other side's summary of it, and being able to check a
// quoted line against the log is most of what its one hard rule is for.
async function speakTurn(speaker, { brief, turns, role }) {
  const transcript = renderTranscript(turns);
  const body = transcript
    ? `${brief}\n\n[СТЕНОГРАММА ЗАСЕДАНИЯ]\n${transcript}\n\n${turnInstruction(turns)}`
    : `${brief}\n\n${turnInstruction(turns)}`;

  const spoken = await speaker.speak(speakerPrompt(role), body);
  return {
    turn: { ...spoken.fields, role, model: speaker.model, vendor: speaker.vendor },
    usage: spoken.usage,
  };
}

async function holdHearing(speaker, brief) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = (u) => {
    usage.inputTokens += u.inputTokens || 0;
    usage.outputTokens += u.outputTokens || 0;
  };

  const accusation = await speakTurn(speaker, { brief, turns: [], role: "prosecutor" });
  count(accusation.usage);

  const defence = await speakTurn(speaker, {
    brief,
    turns: [{ ...accusation.turn, n: 1 }],
    role: "advocate",
  });
  count(defence.usage);

  return {
    turns: [accusation.turn, defence.turn],
    vendor: speaker.vendor,
    model: speaker.model,
    effort: `${speaker.effort} / 2 хода`,
    usage,
  };
}

/**
 * Opens the hearing for one case, on the first vendor that manages both turns.
 *
 * @param {object}   params
 * @param {object[]} params.speakers  from buildSpeakers(), ordered cheapest-first
 * @param {string}   params.brief     the plain-text dossier, from unbanDossierRepo.getCaseBrief()
 * @returns {Promise<{turns: object[], vendor: string, model: string, effort: string,
 *                    usage: {inputTokens: number, outputTokens: number}}>}
 *          Shaped for lib/unbanOpinionsValidation.js's parseOpinions(), which is what actually
 *          enforces the field caps and stores the result.
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

/**
 * Adds ONE speech to a hearing already on the sheet - the "передать слово" button.
 *
 * Retried per turn rather than per hearing; see this file's header for why the two entry points
 * differ on that.
 *
 * @param {object}   params
 * @param {object[]} params.speakers
 * @param {string}   params.brief
 * @param {object[]} params.turns  the transcript so far, from the stored document
 * @param {"prosecutor"|"advocate"} params.role  who has the floor, decided by the caller
 * @returns {Promise<{turn: object, vendor: string, model: string,
 *                    usage: {inputTokens: number, outputTokens: number}}>}
 */
async function generateTurn({ speakers, brief, turns, role }) {
  if (!brief || !String(brief).trim()) {
    throw new OpinionsGenerationError("empty_brief", "brief is empty");
  }
  if (!speakers || !speakers.length) {
    throw new OpinionsGenerationError("no_vendor", "no model vendor is configured");
  }
  if (!turns || !turns.length) {
    // Nothing to answer means this is an opening, and an opening is generateOpinions()'s job - it
    // buys the advocate's reply in the same press. Reaching here is a caller bug, not a bad case.
    throw new OpinionsGenerationError("empty_hearing", "no transcript to continue");
  }

  let last = null;
  for (const speaker of speakers) {
    try {
      const spoken = await speakTurn(speaker, { brief, turns, role });
      return {
        turn: spoken.turn,
        vendor: speaker.vendor,
        model: speaker.model,
        usage: spoken.usage,
      };
    } catch (err) {
      if (!(err instanceof OpinionsGenerationError)) throw err;
      last = err;
      console.warn(
        `[opinions] ${speaker.vendor} (${speaker.model}) failed on a ${role} turn: ${err.reason} - ${err.message}`
      );
    }
  }
  throw last;
}

module.exports = {
  generateOpinions,
  generateTurn,
  buildSpeakers,
  OpinionsGenerationError,
  MODEL,
  EFFORT,
  GOOGLE_MODEL,
  MAX_TOKENS,
  SPEECH_TOOL,
  // exported for the unit tests
  _internal: {
    PROMPTS,
    anthropicSpeaker,
    googleSpeaker,
    LENGTH_RULE,
    toGoogleSchema,
    renderTranscript,
    turnInstruction,
  },
};
