// Validation for the /<channel>/counters page, mirroring the bot's own rules - the panel
// must not accept a counter chat couldn't create or update. The bot's matchers
// (TwitchBot/commands/CustomCommands.js) are /!addcounter #([a-zа-я0-9]+)/ and
// /^#([a-zа-я0-9]+)/ against the RAW message: lowercase-only, so an uppercase name saved
// here could never be updated from chat. normalizeName therefore lowercases.
//
// Pure functions, unit-tested in tests/counterValidation.test.js.

const NAME_PATTERN = /^[a-zа-я0-9]+$/;
const MAX_NAME_LENGTH = 30;
// A counter is a chat-visible tally; anything a human would legitimately count fits
// comfortably in ±1e9, and capping it keeps the value a safe integer everywhere.
const MAX_COUNT = 1_000_000_000;
const ACCESS_VALUES = ["all", "mods"];

function normalizeName(value) {
  return (value || "").toString().trim().replace(/^#+/, "").toLowerCase();
}

function parseCounter({ name, count, access }) {
  const counter_name = normalizeName(name);
  if (!counter_name) return { ok: false, error: "name_required" };
  if (counter_name.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!NAME_PATTERN.test(counter_name)) return { ok: false, error: "name_invalid" };

  // An empty count field means "start at 0" (the same default !addcounter uses).
  const rawCount = String(count ?? "").trim();
  const parsedCount = rawCount === "" ? 0 : Number(rawCount);
  if (!Number.isInteger(parsedCount) || Math.abs(parsedCount) > MAX_COUNT) {
    return { ok: false, error: "count_invalid" };
  }

  if (!ACCESS_VALUES.includes(access)) return { ok: false, error: "access_invalid" };

  return { ok: true, counter: { counter_name, count: parsedCount, access } };
}

module.exports = { NAME_PATTERN, MAX_NAME_LENGTH, MAX_COUNT, ACCESS_VALUES, normalizeName, parseCounter };
