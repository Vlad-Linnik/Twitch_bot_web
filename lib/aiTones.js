// The named tones of one channel (ChannelConfig's ai.tones + ai.toneId) and which of them is on.
//
// The bot knows nothing about the list. It reads ai.tone, a plain string, and that stays the only
// thing it reads: every write here re-derives ai.tone from the chosen tone, so switching reaches
// chat through the bot's ordinary settings refresh.
//
// Pure, so the rules are testable without Mongo (tests/aiTones.test.js).
const crypto = require("crypto");

const MAX_TONE_LEN = 1000;
const MAX_TONE_NAME_LEN = 40;
// The whole form must stay inside express.urlencoded's 100kB: a Cyrillic letter is six bytes
// there, so ten full tones plus a full cheat sheet is about 85kB.
const MAX_TONES = 10;
// A tone saved before there was a list. The id is fixed because the list is derived on every read
// until the first save, and the page's id has to mean the same thing when the form comes back.
const LEGACY_ID = "legacy";

const newId = () => crypto.randomBytes(6).toString("hex");

// The browser sends line breaks as CRLF; without folding them an untouched text would differ from
// the stored one and every save would be journalled as an edit.
const cleanText = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_TONE_LEN);
const cleanName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TONE_NAME_LEN).trim();

// A tone nobody named goes by how its text begins.
function nameOf(name, text) {
  const clean = cleanName(name);
  if (clean) return clean;
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > MAX_TONE_NAME_LEN ? `${firstLine.slice(0, MAX_TONE_NAME_LEN - 1).trim()}…` : firstLine;
}

const toneText = (tones, toneId) => tones.find((t) => t.id === toneId)?.text ?? "";

// The stored block -> { tones: [{id, name, text}], toneId }. toneId "" means no tone is on.
function readTones(ai) {
  if (Array.isArray(ai?.tones)) {
    const toneId = ai.tones.some((t) => t.id === ai.toneId) ? ai.toneId : "";
    return { tones: ai.tones, toneId };
  }
  const text = cleanText(ai?.tone);
  if (!text) return { tones: [], toneId: "" };
  return { tones: [{ id: LEGACY_ID, name: nameOf("", text), text }], toneId: LEGACY_ID };
}

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

// The form: parallel aiToneId/aiToneName/aiToneText, one per card, and aiToneActive holding the id
// of the chosen card. A card added in the browser carries a made-up id ("new-1") that only ties it
// to aiToneActive; it gets a real one here. A body without the marker field did not render the list
// (the page was open since before it existed), so it changes nothing.
function parseTones(body, existingAi) {
  const stored = readTones(existingAi);
  if (body.aiTones === undefined) return { ...stored, tone: toneText(stored.tones, stored.toneId) };

  const known = new Set(stored.tones.map((t) => t.id));
  const names = asArray(body.aiToneName);
  const texts = asArray(body.aiToneText);
  const chosen = String(body.aiToneActive ?? "");
  const tones = [];
  let toneId = "";
  asArray(body.aiToneId).forEach((raw, i) => {
    if (tones.length >= MAX_TONES) return;
    const formId = String(raw);
    const text = cleanText(texts[i]);
    const name = nameOf(names[i], text);
    if (!name && !text) return;
    // delete() both keeps a known id and stops a repeated one from being kept twice.
    const id = known.delete(formId) ? formId : newId();
    tones.push({ id, name, text });
    if (formId && formId === chosen && !toneId) toneId = id;
  });
  return { tones, toneId, tone: toneText(tones, toneId) };
}

// Switching without saving the rest of the form. null when there is no such tone.
function chooseTone(existingAi, toneId) {
  const { tones } = readTones(existingAi);
  if (toneId !== "" && !tones.some((t) => t.id === toneId)) return null;
  return { tones, toneId, tone: toneText(tones, toneId) };
}

// What changed, as SettingsChangeLog rows. The tone in effect is logged under ai.tone with its full
// text, as it was before there was a list; ai.tones rows cover what that one cannot show - a tone
// that was added, renamed, deleted, or edited while off.
function diffTones(existingAi, next) {
  const before = readTones(existingAi);
  const beforeTone = toneText(before.tones, before.toneId);
  const changes = [];
  if (beforeTone !== next.tone) changes.push({ field: "ai.tone", before: beforeTone, after: next.tone });

  const line = (t) => (t ? `${t.name}: ${t.text}` : null);
  const ids = new Set([...before.tones, ...next.tones].map((t) => t.id));
  for (const id of ids) {
    const was = before.tones.find((t) => t.id === id);
    const now = next.tones.find((t) => t.id === id);
    if (line(was) === line(now)) continue;
    const loggedAbove = was && now && was.name === now.name && before.toneId === id && next.toneId === id;
    if (!loggedAbove) changes.push({ field: "ai.tones", before: line(was), after: line(now) });
  }
  return changes;
}

module.exports = { MAX_TONE_LEN, MAX_TONE_NAME_LEN, MAX_TONES, readTones, parseTones, chooseTone, diffTones };
