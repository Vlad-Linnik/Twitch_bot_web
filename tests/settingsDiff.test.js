const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { diffConfig } = require("../lib/settingsDiff");

const baseConfig = () => ({
  bannedWords: { words: ["foo"], timeoutReason: "no" },
  spamSignatures: ["bar"],
  spamBanReason: "spam",
  responses: { busy: [], yesNo: [] },
  commands: {
    topchatters: { enabled: true, cooldownMs: 1000 },
    insult: { enabled: false },
  },
});

describe("diffConfig", () => {
  test("returns nothing when nothing changed", () => {
    const config = baseConfig();
    assert.deepEqual(diffConfig(config, config), []);
  });

  test("reports a changed top-level field", () => {
    const before = baseConfig();
    const after = { ...before, spamBanReason: "different" };
    const changes = diffConfig(before, after);
    assert.deepEqual(changes, [{ field: "spamBanReason", before: "spam", after: "different" }]);
  });

  test("diffs commands one level deep, not as one blob", () => {
    const before = baseConfig();
    const after = {
      ...before,
      commands: { ...before.commands, insult: { enabled: true } },
    };
    const changes = diffConfig(before, after);
    assert.deepEqual(changes, [
      { field: "commands.insult", before: { enabled: false }, after: { enabled: true } },
    ]);
  });

  test("reports a command added or removed entirely", () => {
    const before = baseConfig();
    const after = { ...before, commands: { topchatters: before.commands.topchatters } };
    const changes = diffConfig(before, after);
    assert.deepEqual(changes, [
      { field: "commands.insult", before: { enabled: false }, after: null },
    ]);
  });

  test("ignores unrelated fields not in the tracked list", () => {
    const before = baseConfig();
    const after = { ...before, channelLogin: "somethingElse", updatedAt: new Date() };
    assert.deepEqual(diffConfig(before, after), []);
  });
});
