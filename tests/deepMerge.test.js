const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { deepMerge, isPlainObject } = require("../lib/deepMerge");

describe("isPlainObject", () => {
  test("true for plain objects, false for arrays/null/scalars", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("x"), false);
    assert.equal(isPlainObject(5), false);
  });
});

describe("deepMerge", () => {
  test("nested plain objects merge recursively", () => {
    const base = { commands: { a: { enabled: true, cooldownMs: 100 }, b: { enabled: true } } };
    const override = { commands: { a: { enabled: false } } };
    const result = deepMerge(base, override);
    assert.deepEqual(result.commands.a, { enabled: false, cooldownMs: 100 });
    assert.deepEqual(result.commands.b, { enabled: true });
  });

  test("keys only in base survive (a doc predating a new default command still gets it)", () => {
    const base = { commands: { delcommand: { enabled: true, signature: "!delcommand" } } };
    const result = deepMerge(base, { commands: {} });
    assert.deepEqual(result.commands.delcommand, { enabled: true, signature: "!delcommand" });
  });

  test("arrays and scalars override, never merge", () => {
    const base = { list: ["a", "b"], n: 1 };
    const result = deepMerge(base, { list: ["c"], n: 2 });
    assert.deepEqual(result.list, ["c"]);
    assert.equal(result.n, 2);
  });

  test("does not mutate its inputs", () => {
    const base = { nested: { x: 1 } };
    const override = { nested: { y: 2 } };
    deepMerge(base, override);
    assert.deepEqual(base, { nested: { x: 1 } });
    assert.deepEqual(override, { nested: { y: 2 } });
  });
});
