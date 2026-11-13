// Validation for the /<channel>/variables page, mirroring the bot's own rules - the panel
// must not accept a variable chat couldn't create or update. The bot's matchers
// (TwitchBot/commands/CustomCommands.js, VARIABLE_NAME) are "!addvar #([a-zа-яё0-9]+)" and
// /^#([a-zа-яё0-9]+)/ against the RAW message: lowercase-only, so an uppercase name saved
// here could never be updated from chat. normalizeName therefore lowercases. "ё" sits outside
// the а-я range and is listed on its own, on both sides.
//
// Pure functions, unit-tested in tests/variableValidation.test.js.

const NAME_PATTERN = /^[a-zа-яё0-9]+$/;
const MAX_NAME_LENGTH = 30;
// A numeric variable is a chat-visible tally; anything a human would legitimately count fits
// comfortably in ±1e9, and capping it keeps the value a safe integer everywhere.
const MAX_VALUE = 1_000_000_000;
const ACCESS_VALUES = ["all", "mods"];

function normalizeName(value) {
  return (value || "").toString().trim().replace(/^#+/, "").toLowerCase();
}

function parseVariable({ name, value, access }) {
  const normalized = normalizeName(name);
  if (!normalized) return { ok: false, error: "name_required" };
  if (normalized.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!NAME_PATTERN.test(normalized)) return { ok: false, error: "name_invalid" };

  // An empty value field means "start at 0" (the same default !addvar uses).
  const rawValue = String(value ?? "").trim();
  const parsedValue = rawValue === "" ? 0 : Number(rawValue);
  if (!Number.isInteger(parsedValue) || Math.abs(parsedValue) > MAX_VALUE) {
    return { ok: false, error: "value_invalid" };
  }

  if (!ACCESS_VALUES.includes(access)) return { ok: false, error: "access_invalid" };

  return { ok: true, variable: { name: normalized, value: parsedValue, access } };
}

module.exports = { NAME_PATTERN, MAX_NAME_LENGTH, MAX_VALUE, ACCESS_VALUES, normalizeName, parseVariable };
