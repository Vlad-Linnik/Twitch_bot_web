// Validates the hearing printed on an unban case's fourth sheet - see routes/unbanBureau.js's
// "заказать разбор" / "передать слово" buttons and routes/adminApi.js's PUT
// /admin/api/unban-requests/:id/opinions. Extracted to lib/ per this repo's convention that
// route-level parsing worth testing lives here (see lib/settingsValidation.js's own header).
//
// WHAT WRITES THIS. Three callers now, and this validator is deliberately the only way in for all
// of them:
//   - routes/unbanBureau.js's "заказать разбор" button, which opens the hearing here and now via
//     lib/unbanOpinionsGenerator.js (Gemini first, Anthropic only when that fails);
//   - the same file's "передать слово" button, which appends ONE more speech to a hearing that
//     already exists, and the judge's remark, which appends a turn nobody paid a token for;
//   - routes/adminApi.js's PUT .../opinions, the original path, still used by the local driver
//     scripts/local/opinions.js and the hand-run agents in ../../.claude/agents/amnesty-*-v4.md.
// Model output goes through this file rather than straight into the repo on purpose: the length
// caps live here, and a model that ran long has to be rejected by the same rule regardless of which
// caller paid for it.
//
// Either way the input is trusted in the sense that it isn't attacker-supplied, and untrusted in
// the sense that it is model output landing on a page a tier-2 moderator reads: it gets
// length-capped and stripped of control characters here, and rendered client-side through
// textContent plus the one-marker tokenizer in public/js/games/engines/speechMarkup.js.
//
// ── THE SHAPE IS AN ORDERED TRANSCRIPT ──────────────────────────────────────────────────────────
//
// A hearing is `turns[]`, in the order they were spoken. It used to be two fixed sides
// (`{prosecutor, advocate, decision}`), which was the right shape while a hearing was exactly two
// speeches decided in one call and never touched again. It stopped being the right shape the moment
// the desk could hand the floor back: a moderator may now call on either side repeatedly and put
// their own remarks between the speeches, and "whose turn was third" is not something two keyed
// slots can express. Turn order is not decoration here - each speech answers the one above it, and
// a sheet that cannot say which that was is a sheet that cannot be read.
//
// A TURN IS FIELDS, NOT A PARAGRAPH. `speech` is still the body, but the things a moderator
// actually scans for - which rule point is in play, what the side is asking for, which log lines it
// leans on - are their own fields, because they were the parts hardest to find inside a wall of
// prose and the parts most worth colouring differently. The model fills them in one forced tool
// call; see lib/unbanOpinionsGenerator.js's SPEECH_TOOL for the field mechanics and
// config/amnestyPrompts/ for the policy. That split is the same one ../CLAUDE.md draws for the bot
// under "Rules are config too, guarantees are code".
//
// THE OLD SHAPE IS READ, NEVER REWRITTEN. Sheets written before this change are still on prod, and
// the by-hand PUT still speaks the old body. Both are normalized into turns on the way through -
// toTranscript() for a stored document, parseOpinions() for an incoming body - rather than migrated
// in place. A migration would have to be run once, correctly, against a collection whose only
// backup is the fact that nothing has ever deleted from it, to buy nothing a twenty-line adapter
// doesn't: these documents are read one at a time, by one page, and the adapter is covered by tests
// where a one-shot script would not be.
//
// The legacy fields map onto turns without losing anything: `prosecutor.opening` is turn 1,
// `advocate.opening` is turn 2, a `rebuttal` is a third turn by the prosecutor, and a `revised`
// accusation replaces turn 1's text and marks it as rewritten - which is what `final` (derived,
// never submitted) and `decision` said between them in the old shape.
const MAX_OPINION_CHARS = 2000;

// The short fields around the speech. These are labels, not prose: a rule reference is "пункт 3 -
// оскорбления", a demand is "оставить бан навсегда". They are TRUNCATED rather than rejected, which
// is the opposite of how `speech` is treated below, and deliberately so - failing an entire paid
// hearing because a model wrote 240 characters of demand instead of 220 would throw away three good
// speeches over a caption.
const MAX_RULE_CHARS = 90;
const MAX_HEADLINE_CHARS = 180;
const MAX_DEMAND_CHARS = 220;
const MAX_COUNTER_CHARS = 450;
// Quotes are lines lifted out of the applicant's own chat log. The per-quote cap matches the one
// lib/unbanCaseBrief.js's oneLine() already applies to those lines going IN, so a quote cannot come
// back longer than the brief could have shown it.
const MAX_QUOTE_CHARS = 220;
const MAX_QUOTES = 4;

// The judge's own remark. Bounded well under a speech because it is typed by hand into a box on the
// sheet, and because every remark is re-sent as part of the transcript on every later turn.
const MAX_REMARK_CHARS = 600;

// How long a hearing may run. Two numbers, not one, because the two things being bounded are
// different: SPOKEN turns cost a model call each and are the actual spend, while a judge's remarks
// cost nothing and are bounded only so the sheet, and the prompt built from it, stay finite.
const MAX_SPOKEN_TURNS = 8;
const MAX_TURNS = 20;

const SIDES = ["prosecutor", "advocate"];
const ROLES = ["prosecutor", "advocate", "judge"];
const DECISIONS = ["rewrite", "rebut", "silent"];

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// C0/C1 control characters, minus CR and LF which clean() normalizes right after: a speech is prose
// and a speaker may well paragraph it, but nothing else in that range belongs on a printed sheet.
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

// A caption field: one line, capped, ellipsised rather than refused. The newline collapse matters as
// much as the cap - these render into fixed-height chips beside the role name, and a model that
// answered "пункт 3\nпункт 5" would otherwise silently break that row's layout.
function oneLine(raw, max) {
  const text = clean(raw).split(LF).join(" ").replace(/\s{2,}/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function parseQuotes(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? raw.split(LF) : [];
  const out = [];
  for (const entry of list) {
    // An entry may arrive as an object if a future caller wants to keep the timestamp apart from the
    // text; the model's own tool returns plain strings, and both collapse to one line here.
    const text = oneLine(entry && typeof entry === "object" ? entry.text : entry, MAX_QUOTE_CHARS);
    if (text) out.push(text);
    if (out.length >= MAX_QUOTES) break;
  }
  return out;
}

/**
 * Parses one spoken turn - a speech by the prosecutor or the advocate.
 *
 * `speech` is the one field that can fail the turn. The short fields around it are truncated (see
 * the cap constants above); an empty or over-long speech is a failed turn, because a sheet whose
 * body is missing has nothing on it to read and the generator can still retry the other vendor.
 *
 * @param {object} raw   `{rule, headline, speech, quotes, demand, counter}` - the tool's fields
 * @param {object} meta  `{role, n, model, vendor, at, revised}`
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
function parseSpeechTurn(raw, meta = {}) {
  const side = raw && typeof raw === "object" ? raw : {};
  const role = SIDES.includes(meta.role) ? meta.role : SIDES[0];

  // `opening` is accepted as an alias so the legacy PUT body and the new tool output land in the
  // same parser rather than in two that drift.
  const body = side.speech === undefined || side.speech === null || side.speech === ""
    ? side.opening
    : side.speech;
  const speech = clean(body);
  if (!speech) return { ok: false, reason: role + "_speech_required" };
  if (speech.length > MAX_OPINION_CHARS) return { ok: false, reason: role + "_speech_too_long" };

  return {
    ok: true,
    value: {
      n: Number.isInteger(meta.n) && meta.n > 0 ? meta.n : 1,
      role,
      rule: oneLine(side.rule, MAX_RULE_CHARS),
      headline: oneLine(side.headline, MAX_HEADLINE_CHARS),
      speech,
      quotes: parseQuotes(side.quotes),
      demand: oneLine(side.demand, MAX_DEMAND_CHARS),
      counter: oneLine(side.counter, MAX_COUNTER_CHARS),
      // Provenance per turn rather than per document: a hearing can now be finished by a different
      // vendor than opened it (see the generator's per-turn retry), so one `model` field on the
      // document would be a lie about most of the sheet.
      model: oneLine(meta.model, 80) || null,
      vendor: oneLine(meta.vendor, 40) || null,
      // Only ever set by the legacy adapter, where a rewritten accusation replaced the first one and
      // the sheet has to say so - otherwise a moderator cannot tell a first draft from a second.
      revised: meta.revised === true,
      // The draft that rewrite replaced. The old shape stored both and printed only the survivor;
      // keeping it means the adapter loses nothing, and it round-trips because parseOpinions()
      // spreads a stored turn into this function's meta.
      supersededSpeech: clean(meta.supersededSpeech) || null,
      at: meta.at instanceof Date ? meta.at : new Date(),
    },
  };
}

/**
 * Parses the judge's own remark - the moderator at the desk speaking into the hearing.
 *
 * The author travels ON the turn rather than being looked up when the sheet is rendered. Two
 * reasons, and both are about it being a record: a desk is worked by whoever holds the shift, so the
 * remark on turn 5 and the remark on turn 9 are routinely different people, and a display name or
 * nick colour looked up later is the author's name TODAY, not the one they signed with.
 *
 * @param {object} params `{text, author: {userId, login, displayName, avatarUrl, color}, n, at}`
 */
function parseJudgeTurn({ text, author, n, at } = {}) {
  const speech = clean(text);
  if (!speech) return { ok: false, reason: "remark_required" };
  if (speech.length > MAX_REMARK_CHARS) return { ok: false, reason: "remark_too_long" };

  const who = author && typeof author === "object" ? author : {};
  return {
    ok: true,
    value: {
      n: Number.isInteger(n) && n > 0 ? n : 1,
      role: "judge",
      speech,
      author: {
        userId: oneLine(who.userId, 40) || null,
        login: oneLine(who.login, 40) || null,
        displayName: oneLine(who.displayName, 60) || oneLine(who.login, 40) || null,
        // Both are display-only and both are allowed to be missing: a moderator with no avatar
        // cached renders as a blank disc, and one who never set a chat colour renders in the sheet's
        // own ink. Neither is worth failing a remark over. Checked rather than trusted all the same
        // - these two go straight into an `src` and a `style.color` on the page.
        avatarUrl: typeof who.avatarUrl === "string" && /^https:\/\/[^\s"'<>]+$/.test(who.avatarUrl)
          ? who.avatarUrl.slice(0, 400)
          : null,
        color: typeof who.color === "string" && /^#[0-9a-fA-F]{6}$/.test(who.color)
          ? who.color
          : null,
      },
      at: at instanceof Date ? at : new Date(),
    },
  };
}

// Renumbers a transcript so `n` is always the position in the list. The model is told which turn it
// is answering by number, so these numbers are read back out of the prompt - they have to be the
// list's own indices and not whatever a caller happened to pass.
function renumber(turns) {
  return turns.map((turn, i) => ({ ...turn, n: i + 1 }));
}

/**
 * Normalizes ANY stored opinions document into one carrying `turns` - the new shape passes through,
 * the old two-sided shape is adapted. See this file's header for why this is an adapter and not a
 * migration.
 *
 * @param {object|null} doc  a raw UnbanExpertOpinions document
 * @returns {object|null}    the same document with a `turns` array
 */
function toTranscript(doc) {
  if (!doc || typeof doc !== "object") return null;

  if (Array.isArray(doc.turns)) {
    return { ...doc, turns: renumber(doc.turns.filter((t) => t && ROLES.includes(t.role))) };
  }

  const turns = [];
  const push = (raw, role, meta) => {
    const parsed = parseSpeechTurn(raw, {
      role,
      n: turns.length + 1,
      at: doc.generatedAt,
      model: doc.model,
      ...meta,
    });
    if (parsed.ok) turns.push(parsed.value);
  };

  const p = doc.prosecutor || null;
  const a = doc.advocate || null;
  // `final` first, `opening` second: on a legacy document `final` IS the accusation the sheet
  // printed, and reproducing what that sheet showed matters more here than which draft it came from.
  if (p) push({ speech: p.final || p.opening }, "prosecutor", { revised: Boolean(p.revised) });
  if (a) push({ speech: a.final || a.opening }, "advocate");
  if (p && p.rebuttal) push({ speech: p.rebuttal }, "prosecutor");

  return { ...doc, turns: renumber(turns) };
}

/**
 * Whose turn it is next, given a transcript.
 *
 * The judge never takes the floor from a side - a remark is an interjection, not a speech - so the
 * question is always "which of the two spoke last", skipping past any number of judge turns to find
 * out. An empty transcript opens with the prosecutor, which is the order the hearing has always run
 * in and the reason the advocate's prompt can assume it is answering something.
 *
 * @param {object[]} turns
 * @returns {"prosecutor"|"advocate"}
 */
function nextSpeaker(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const role = list[i] && list[i].role;
    if (role === "prosecutor") return "advocate";
    if (role === "advocate") return "prosecutor";
  }
  return "prosecutor";
}

function countSpoken(turns) {
  return (Array.isArray(turns) ? turns : []).filter((t) => t && SIDES.includes(t.role)).length;
}

/**
 * Parses a body into the document body stored by db/unbanOpinionsRepo.js.
 *
 * Accepts BOTH shapes on purpose - see the header. A body carrying `turns` is the generator's own
 * output; a body carrying `prosecutor`/`advocate` is the by-hand admin PUT, which is a live workflow
 * and must keep working unchanged.
 *
 * @param {object} body  `{turns}` or `{prosecutor: {opening, revised?, rebuttal?}, advocate:
 *                        {opening}, model?, effort?}`
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 */
function parseOpinions(body) {
  const input = body && typeof body === "object" ? body : {};
  const turns = [];

  if (Array.isArray(input.turns)) {
    for (const raw of input.turns) {
      const role = raw && raw.role;
      const parsed = role === "judge"
        ? parseJudgeTurn({ ...raw, text: raw.speech, n: turns.length + 1 })
        : parseSpeechTurn(raw, { ...raw, role, n: turns.length + 1 });
      if (!parsed.ok) return parsed;
      turns.push(parsed.value);
    }
    if (!turns.length) return { ok: false, reason: "empty_hearing" };
    if (turns.length > MAX_TURNS) return { ok: false, reason: "too_many_turns" };
  } else {
    // Legacy body. Both sides are required, exactly as they were - a PUT carrying only half a
    // hearing was refused before this change and is refused now.
    for (const role of SIDES) {
      const side = input[role] && typeof input[role] === "object" ? input[role] : {};
      const revised = role === "prosecutor" ? clean(side.revised) : "";
      const parsed = parseSpeechTurn(side, {
        role,
        n: turns.length + 1,
        model: input.model,
        // A rewritten accusation is what the sheet prints, and it prints it marked.
        revised: Boolean(revised),
      });
      if (!parsed.ok) {
        // Reported under the old field name: the driver that sends this body knows `opening`, not
        // `speech`, and a reason naming a field it never sent is a reason it cannot act on.
        return { ok: false, reason: parsed.reason.replace("_speech_", "_opening_") };
      }
      if (role === "prosecutor") {
        const rebuttal = clean(side.rebuttal);
        if (revised.length > MAX_OPINION_CHARS) return { ok: false, reason: "prosecutor_revised_too_long" };
        if (rebuttal.length > MAX_OPINION_CHARS) return { ok: false, reason: "prosecutor_rebuttal_too_long" };
        // The agent picks one form of edit or none. Both present means the driver merged two turns,
        // and the sheet would print the rewritten accusation followed by a reply answering the
        // original - silently incoherent rather than visibly broken, which is worse.
        if (revised && rebuttal) return { ok: false, reason: "prosecutor_two_edits" };
        if (revised) {
          parsed.value.supersededSpeech = parsed.value.speech;
          parsed.value.speech = revised;
        }
      }
      turns.push(parsed.value);
    }
    const rebuttal = clean((input.prosecutor || {}).rebuttal);
    if (rebuttal) {
      const parsed = parseSpeechTurn({ speech: rebuttal }, {
        role: "prosecutor",
        n: turns.length + 1,
        model: input.model,
      });
      if (!parsed.ok) return parsed;
      turns.push(parsed.value);
    }
  }

  // What the prosecutor did with a second move, in the vocabulary the old shape used. Still derived
  // rather than trusted, and still stored, because it is the one legacy field carrying meaning no
  // turn does: it distinguishes an accusation that was REPLACED from one that was answered.
  const first = turns.find((t) => t.role === "prosecutor");
  const spokeTwice = turns.filter((t) => t.role === "prosecutor").length > 1;
  const decision = first && first.revised ? "rewrite" : spokeTwice ? "rebut" : "silent";

  return {
    ok: true,
    value: {
      turns: renumber(turns),
      decision,
      // Provenance for the document as a whole - which prompt and which vendor opened this hearing.
      // Per-turn provenance lives on the turns; this stays for the admin API's callers, which have
      // always read it.
      model: oneLine(input.model, 80) || null,
      effort: oneLine(input.effort, 40) || null,
    },
  };
}

module.exports = {
  parseOpinions,
  parseSpeechTurn,
  parseJudgeTurn,
  toTranscript,
  nextSpeaker,
  countSpoken,
  MAX_OPINION_CHARS,
  MAX_REMARK_CHARS,
  MAX_SPOKEN_TURNS,
  MAX_TURNS,
  MAX_QUOTES,
  DECISIONS,
  ROLES,
  SIDES,
  // exported for the unit tests
  _internal: { clean, oneLine, parseQuotes, renumber, isControl },
};
