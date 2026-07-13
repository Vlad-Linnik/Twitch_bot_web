// Deep-merge with the same semantics as the bot's config/channelSettings.js:
// plain objects recurse, everything else (arrays, scalars, null) overrides.
// Kept separate and pure so it's unit-testable (tests/deepMerge.test.js).

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = isPlainObject(base[key]) && isPlainObject(override[key])
      ? deepMerge(base[key], override[key])
      : override[key];
  }
  return result;
}

module.exports = { deepMerge, isPlainObject };
