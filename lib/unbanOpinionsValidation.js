// Validates the two adversarial expert opinions written onto an unban case's fourth sheet -
// see routes/adminApi.js's PUT /admin/api/unban-requests/:id/opinions. Extracted to lib/ per this
// repo's convention that route-level parsing worth testing lives here (see lib/settingsValidation.js's
// own header).
//
// WHAT WRITES THIS. Not a browser and not this app: the opinions are produced by Claude Code running
// two subagents (`.claude/agents/amnesty-{prosecutor,advocate}.md`) against a brief from
// GET .../brief, then PUT here by a local driver script. This site never calls Anthropic's API and
// never pays for a token - it stores and renders finished text. So the input is trusted in the sense
// that it isn't attacker-supplied, and untrusted in the sense that it is model output landing on a
// page a tier-2 moderator reads: it gets length-capped and stripped of control characters here, and
// rendered through textContent client-side.
//
// THE PROCEDURE IS ASYMMETRIC, AND THE SHAPE MIRRORS IT. The prosecutor opens, the advocate answers
// that opening, and then the prosecutor gets exactly one edit which it chooses the form of:
// rewrite the accusation, append a short reply, or stay silent. So `revised` and `rebuttal` are the
// prosecutor's two possible second moves and are mutually exclusive by construction, while the
// advocate has no second move at all. The advocate's fields exist and stay null on purpose - the
// shape is one normalizer applied twice rather than two near-identical ones, and if the advocate is
// ever given a last word (considered and declined 2026-08-09, see the plan's Стадия B.3) there is
// nowhere new to put it.
//
// `final` IS DERIVED, NEVER SUBMITTED. It's what the sheet prints as the standing accusation:
// `revised || opening`. Accepting it from the caller would allow a document whose `final`
// contradicts both of the texts it is supposed to be one of.

// Measured, not guessed. A live run of the frozen prompt on the `onecrippled` case produced
// 724 / 691 / 482 characters against a prompt asking for "до 60 слов" - i.e. the accusation alone
// would have failed the 700-char cap this was originally specced at. 1200 is ~2x the observed
// maximum: a backstop against a model running away with itself, not a formatting rule. The prompt's
// own 60-word figure is deliberately left as-is (raising it tends to drag output length up with it),
// so this ceiling must stay well clear of what the prompt actually produces.
const MAX_OPINION_CHARS = 1200;

const ROLES = ["prosecutor", "advocate"];
const DECISIONS = ["rewrite", "rebut", "silent"];

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// C0/C1 control characters, minus CR and LF which clean() normalizes right after: a speech is prose
// and an agent may well paragraph it, but nothing else in that range belongs on a printed sheet.
// Written as a code check rather than a regex character class on purpose - such a class can only be
// spelled with escape sequences, and a literal control byte sitting in the source is one careless
// editor save away from silently becoming a different filter.
function isControl(code) {
  if (code === 0x0a || code === 0x0d) return false; // LF, CR
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function stripControls(text) {
  let out = "";
  for (const ch of text) {
    if (!isControl(ch.codePointAt(0))) out += ch;
  }
  return out;
}

function clean(raw) {
  let text = stripControls(String(raw ?? ""));
  text = text.split(CR + LF).join(LF).split(CR).join(LF);
  // Trailing spaces on a line are invisible in the source text and would survive into the sheet's
  // `white-space: pre-wrap`, where they do affect where a line wraps. Stripping them here makes what
  // is stored the same as what is read.
  text = text.split(LF).map((line) => line.replace(/[ ]+$/, "")).join(LF);
  // Collapse runs of blank lines. A speech is a few paragraphs at most; anything longer is the
  // model padding the sheet, and the sheet has a fixed height.
  const triple = LF + LF + LF;
  while (text.includes(triple)) text = text.split(triple).join(LF + LF);
  return text.trim();
}

function parseSide(raw, role) {
  const side = raw && typeof raw === "object" ? raw : {};
  const opening = clean(side.opening);
  if (!opening) return { ok: false, reason: `${role}_opening_required` };
  if (opening.length > MAX_OPINION_CHARS) return { ok: false, reason: `${role}_opening_too_long` };

  const revised = clean(side.revised);
  const rebuttal = clean(side.rebuttal);
  if (revised.length > MAX_OPINION_CHARS) return { ok: false, reason: `${role}_revised_too_long` };
  if (rebuttal.length > MAX_OPINION_CHARS) return { ok: false, reason: `${role}_rebuttal_too_long` };
  // The agent picks one form of edit or none. Both present means the driver merged two turns, and
  // the sheet would print the rewritten accusation followed by a reply answering the original -
  // silently incoherent rather than visibly broken, which is worse.
  if (revised && rebuttal) return { ok: false, reason: `${role}_two_edits` };

  return {
    ok: true,
    value: {
      opening,
      revised: revised || null,
      rebuttal: rebuttal || null,
      final: revised || opening,
    },
  };
}

/**
 * Parses a PUT body into the document body stored by db/unbanOpinionsRepo.js.
 *
 * @param {object} body  `{ prosecutor: {opening, revised?, rebuttal?}, advocate: {opening},
 *                          model?, effort? }`
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
function parseOpinions(body) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  for (const role of ROLES) {
    const parsed = parseSide(input[role], role);
    if (!parsed.ok) return parsed;
    out[role] = parsed.value;
  }

  // What the prosecutor chose to do with its one edit. Derived from which field arrived rather than
  // trusted from the caller, so it can't disagree with the texts: a stated "rewrite" carrying no
  // revised text would render a sheet claiming an edit that isn't there.
  const p = out.prosecutor;
  const decision = p.revised ? "rewrite" : p.rebuttal ? "rebut" : "silent";

  return {
    ok: true,
    value: {
      ...out,
      decision,
      // Provenance, for when a sheet reads oddly months later and the question is which prompt
      // wrote it. Free-form, capped, never rendered.
      model: clean(input.model).slice(0, 80) || null,
      effort: clean(input.effort).slice(0, 40) || null,
    },
  };
}

module.exports = {
  parseOpinions,
  MAX_OPINION_CHARS,
  DECISIONS,
  ROLES,
  // exported for the unit tests
  _internal: { clean, parseSide, isControl },
};
