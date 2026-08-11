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
// WHY SONNET 5 AND NOT A CHEAPER MODEL. Measured on three real cases, not assumed. Haiku 4.5 has no
// `effort` parameter at all, so thinking depth can only be bought with a fixed `budget_tokens`, and
// a budget large enough to produce a usable speech cost MORE per case than Sonnet 5's adaptive
// thinking at medium effort ($0.0240 vs $0.0221) - while inventing a timeframe the dossier does not
// contain ("46 mutes in two months" against counters explicitly scoped to the channel's lifetime).
// Cheaper model, dearer and worse. Revisit only with a fresh measurement.
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

const PROMPT_DIR = path.join(__dirname, "../config/amnestyPrompts");

// Read once at boot rather than per request: these are small, they never change at runtime, and a
// missing file should stop the process rather than surface as a failed button press hours later.
const PROMPTS = {
  prosecutor: fs.readFileSync(path.join(PROMPT_DIR, "prosecutor.md"), "utf8").trim(),
  advocate: fs.readFileSync(path.join(PROMPT_DIR, "advocate.md"), "utf8").trim(),
};

const MODEL = "claude-sonnet-5";
const EFFORT = "medium";

// Thinking and the reply share this ceiling, so it is set well clear of what a 2-4 sentence speech
// needs. Measured runs land near 1.5k output tokens including thinking; the headroom exists because
// running out is silent - the API returns a message with no text block at all, not an error. That
// is not hypothetical: at a tighter ceiling a long brief produced an empty speech with
// stop_reason "max_tokens", which is why emptiness is checked explicitly below.
const MAX_TOKENS = 8000;

class OpinionsGenerationError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "OpinionsGenerationError";
    this.reason = reason;
  }
}

async function speak(client, system, userText) {
  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      messages: [{ role: "user", content: userText }],
    });
  } catch (err) {
    // Upstream trouble (rate limit, overload, bad key) is reported as its own reason so the button
    // can say "try again" rather than "the case is broken" - nothing about the case caused it.
    throw new OpinionsGenerationError("upstream", err && err.message ? err.message : String(err));
  }

  // A refusal arrives as a normal 200 with an empty content array, so it has to be checked before
  // the text is read rather than after.
  if (res.stop_reason === "refusal") {
    throw new OpinionsGenerationError("refused", "safety classifier declined the request");
  }

  const text = res.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new OpinionsGenerationError(
      "empty_speech",
      `no text block (stop_reason: ${res.stop_reason})`
    );
  }
  return { text, usage: res.usage };
}

/**
 * Holds the hearing for one case.
 *
 * @param {object}  params
 * @param {object}  params.client  an Anthropic SDK client (injected so this is testable without a
 *                                 key or a network - see tests/unbanOpinionsGenerator.test.js)
 * @param {string}  params.brief   the plain-text dossier, from unbanDossierRepo.getCaseBrief()
 * @returns {Promise<{prosecutor: {opening: string}, advocate: {opening: string}, model: string,
 *                    effort: string, usage: {inputTokens: number, outputTokens: number}}>}
 *          Shaped for lib/unbanOpinionsValidation.js's parseOpinions(), which derives `final` and
 *          `decision` from it - a two-turn hearing has no second move, so `decision` lands on
 *          "silent" without anything here having to say so.
 */
async function generateOpinions({ client, brief }) {
  if (!brief || !String(brief).trim()) {
    throw new OpinionsGenerationError("empty_brief", "brief is empty");
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = (u) => {
    usage.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
    usage.outputTokens += u.output_tokens || 0;
  };

  const accusation = await speak(
    client,
    PROMPTS.prosecutor,
    `${brief}\n\nТы ходишь первым. Предъяви обвинение.`
  );
  count(accusation.usage);

  // The advocate gets the brief again rather than only the accusation: it argues from the dossier,
  // not from the prosecutor's summary of it, and being able to check a quoted line against the log
  // is most of what its one rule is for.
  const defence = await speak(
    client,
    PROMPTS.advocate,
    `${brief}\n\n[ОБВИНЕНИЕ ПРОКУРОРА]\n${accusation.text}\n\nОтвечай.`
  );
  count(defence.usage);

  return {
    prosecutor: { opening: accusation.text },
    advocate: { opening: defence.text },
    model: MODEL,
    effort: `${EFFORT} / 2 хода`,
    usage,
  };
}

module.exports = {
  generateOpinions,
  OpinionsGenerationError,
  MODEL,
  EFFORT,
  MAX_TOKENS,
  // exported for the unit tests
  _internal: { PROMPTS },
};
