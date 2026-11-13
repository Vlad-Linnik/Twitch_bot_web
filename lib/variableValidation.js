// Validation for the /<channel>/variables page, mirroring the bot's own rules - the panel
// must not accept a variable chat couldn't create or update. The name rule (lowercase-only,
// "ё" included, why) and the list of built-in names both live in lib/variableTemplate.js, the
// copy of the bot's shared/variableTemplate.js; normalizeName therefore lowercases.
//
// Pure functions, unit-tested in tests/variableValidation.test.js.
const VariableTemplate = require("./variableTemplate");

const NAME_PATTERN = VariableTemplate.USER_NAME_PATTERN;
const MAX_NAME_LENGTH = VariableTemplate.MAX_NAME_LENGTH;
// A numeric variable is a chat-visible tally; anything a human would legitimately count fits
// comfortably in ±1e9, and capping it keeps the value a safe integer everywhere.
const MAX_VALUE = 1_000_000_000;
const ACCESS_VALUES = ["all", "mods"];

const normalizeName = VariableTemplate.normalizeName;

function parseVariable({ name, value, access }) {
  const normalized = normalizeName(name);
  if (!normalized) return { ok: false, error: "name_required" };
  if (normalized.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!NAME_PATTERN.test(normalized)) return { ok: false, error: "name_invalid" };
  // A channel variable wins over a built-in of the same name, so one created here would switch
  // that built-in off in every command of the channel. The bot's !addvar refuses the same names.
  if (VariableTemplate.isBuiltin(normalized)) return { ok: false, error: "name_reserved" };

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
