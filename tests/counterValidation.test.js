const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeName, parseCounter, MAX_NAME_LENGTH } = require("../lib/counterValidation");

test("normalizeName strips a leading # and lowercases", () => {
  assert.equal(normalizeName("#Wins"), "wins");
  assert.equal(normalizeName("  ##deaths  "), "deaths");
  assert.equal(normalizeName(undefined), "");
});

test("accepts a plain counter, empty count defaults to 0", () => {
  const parsed = parseCounter({ name: "wins", count: "", access: "all" });
  assert.deepEqual(parsed, { ok: true, counter: { counter_name: "wins", count: 0, access: "all" } });
});

test("accepts Cyrillic names, like the bot's own matcher does", () => {
  const parsed = parseCounter({ name: "смерти", count: "5", access: "mods" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.counter.counter_name, "смерти");
  assert.equal(parsed.counter.count, 5);
});

test("uppercase input is lowercased so chat can actually update it", () => {
  // The bot matches #name against the RAW message with a lowercase-only pattern -
  // an uppercase name stored here could never be updated from chat.
  const parsed = parseCounter({ name: "WINS", count: "0", access: "all" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.counter.counter_name, "wins");
});

test("rejects names the bot's matcher would never produce", () => {
  assert.equal(parseCounter({ name: "my counter", count: "0", access: "all" }).error, "name_invalid");
  assert.equal(parseCounter({ name: "win-s", count: "0", access: "all" }).error, "name_invalid");
  assert.equal(parseCounter({ name: "", count: "0", access: "all" }).error, "name_required");
  assert.equal(parseCounter({ name: "a".repeat(MAX_NAME_LENGTH + 1), count: "0", access: "all" }).error, "name_too_long");
});

test("count must be a whole number within range", () => {
  assert.equal(parseCounter({ name: "wins", count: "abc", access: "all" }).error, "count_invalid");
  assert.equal(parseCounter({ name: "wins", count: "1.5", access: "all" }).error, "count_invalid");
  assert.equal(parseCounter({ name: "wins", count: "9999999999", access: "all" }).error, "count_invalid");
  assert.equal(parseCounter({ name: "wins", count: "-3", access: "all" }).ok, true);
});

test("access must be all or mods", () => {
  assert.equal(parseCounter({ name: "wins", count: "0", access: "vip" }).error, "access_invalid");
  assert.equal(parseCounter({ name: "wins", count: "0", access: undefined }).error, "access_invalid");
  assert.equal(parseCounter({ name: "wins", count: "0", access: "mods" }).ok, true);
});
