const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { describeChange } = require("../lib/settingsChangeDescribe");

// A fake t() that doesn't depend on config/locales/*.json wording - it just records which key
// was resolved and with what variables, so these tests assert on describeChange()'s logic (which
// key it picks, what it puts in `vars`) rather than on translated copy.
const t = (key, vars) => `${key}${vars ? ":" + JSON.stringify(vars) : ""}`;

describe("describeChange - custom_command", () => {
  test("add: no prior doc", () => {
    const msg = describeChange(t, { category: "custom_command", action: "add", target: "site", before: null, after: { result: "hi" } });
    assert.equal(msg, 'settingsChangeLog.describe.commandAdded:{"name":"site"}');
  });

  test("delete", () => {
    const msg = describeChange(t, { category: "custom_command", action: "delete", target: "site", before: { result: "hi" }, after: null });
    assert.equal(msg, 'settingsChangeLog.describe.commandDeleted:{"name":"site"}');
  });

  test("update: result text changed", () => {
    const msg = describeChange(t, {
      category: "custom_command", action: "update", target: "site",
      before: { result: "old", timer: null, pin: false, announce: false },
      after: { result: "new", timer: null, pin: false, announce: false },
    });
    assert.match(msg, /commandLabel:\{"name":"site"\}/);
    assert.match(msg, /commandResultChanged/);
  });

  test("update: timer set and cleared", () => {
    const set = describeChange(t, {
      category: "custom_command", action: "update", target: "site",
      before: { result: "x", timer: null }, after: { result: "x", timer: 120000 },
    });
    assert.match(set, /commandTimerSet:\{"seconds":120\}/);

    const cleared = describeChange(t, {
      category: "custom_command", action: "update", target: "site",
      before: { result: "x", timer: 120000 }, after: { result: "x", timer: null },
    });
    assert.match(cleared, /commandTimerCleared/);
  });

  test("update: pin and announce toggles", () => {
    const msg = describeChange(t, {
      category: "custom_command", action: "update", target: "site",
      before: { result: "x", pin: false, announce: false },
      after: { result: "x", pin: true, announce: true },
    });
    assert.match(msg, /commandPinned/);
    assert.match(msg, /commandAnnounceOn/);
  });

  test("update: nothing detectably different falls back to commandUpdated", () => {
    const msg = describeChange(t, {
      category: "custom_command", action: "update", target: "site",
      before: { result: "x" }, after: { result: "x" },
    });
    assert.equal(msg, 'settingsChangeLog.describe.commandUpdated:{"name":"site"}');
  });
});

describe("describeChange - counter", () => {
  test("add", () => {
    const msg = describeChange(t, {
      category: "counter", action: "add", target: "wins", before: null, after: { count: 0, access: "all" },
    });
    assert.equal(msg, 'settingsChangeLog.describe.counterAdded:{"name":"wins","count":0,"access":"settingsChangeLog.describe.access.all"}');
  });

  test("delete", () => {
    const msg = describeChange(t, { category: "counter", action: "delete", target: "wins", before: { count: 5 }, after: null });
    assert.equal(msg, 'settingsChangeLog.describe.counterDeleted:{"name":"wins"}');
  });

  test("update: count and access changed", () => {
    const msg = describeChange(t, {
      category: "counter", action: "update", target: "wins",
      before: { count: 5, access: "all" }, after: { count: 10, access: "mods" },
    });
    assert.match(msg, /counterCountChanged:\{"before":5,"after":10\}/);
    assert.match(msg, /counterAccessChanged/);
  });
});

describe("describeChange - settings: word lists", () => {
  test("bannedWords.words add", () => {
    const msg = describeChange(t, {
      category: "settings", action: "add", target: "bannedWords.words", before: ["a"], after: ["a", "b"],
    });
    assert.equal(msg, 'settingsChangeLog.describe.bannedWordAdded:{"word":"\\"b\\""}');
  });

  test("bannedWords.words delete", () => {
    const msg = describeChange(t, {
      category: "settings", action: "delete", target: "bannedWords.words", before: ["a", "b"], after: ["a"],
    });
    assert.equal(msg, 'settingsChangeLog.describe.bannedWordRemoved:{"word":"\\"b\\""}');
  });

  test("bannedWords.words update reconstructs the rename from the array diff", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "bannedWords.words", before: ["a", "b"], after: ["a", "c"],
    });
    assert.equal(msg, 'settingsChangeLog.describe.bannedWordRenamed:{"before":"\\"b\\"","after":"\\"c\\""}');
  });

  test("spamSignatures follows the same pattern with its own label prefix", () => {
    const msg = describeChange(t, {
      category: "settings", action: "add", target: "spamSignatures", before: [], after: ["spam1"],
    });
    assert.equal(msg, 'settingsChangeLog.describe.spamSignatureAdded:{"word":"\\"spam1\\""}');
  });
});

describe("describeChange - settings: scalar fields", () => {
  test("bannedWords.timeoutReason", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "bannedWords.timeoutReason", before: "old", after: "new",
    });
    assert.match(msg, /timeoutReasonChanged/);
  });

  test("spamBanReason", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "spamBanReason", before: "old", after: "new",
    });
    assert.match(msg, /spamBanReasonChanged/);
  });

  test("commands.insult.enabled on/off", () => {
    const on = describeChange(t, { category: "settings", action: "update", target: "commands.insult.enabled", before: false, after: true });
    assert.match(on, /insultDetectionOn/);
    const off = describeChange(t, { category: "settings", action: "update", target: "commands.insult.enabled", before: true, after: false });
    assert.match(off, /insultDetectionOff/);
  });
});

describe("describeChange - settings: moderator-permission", () => {
  test("falls back to the raw id with no name map", () => {
    const msg = describeChange(t, { category: "settings", action: "update", target: "moderator-permission:12345", before: true, after: false });
    assert.match(msg, /modPermissionRevoked:\{"name":"12345"\}/);
  });

  test("resolves a display name from context.moderatorNames", () => {
    const msg = describeChange(
      t,
      { category: "settings", action: "update", target: "moderator-permission:12345", before: false, after: true },
      { moderatorNames: new Map([["12345", "SomeMod"]]) }
    );
    assert.match(msg, /modPermissionGranted:\{"name":"SomeMod"\}/);
  });
});

describe("describeChange - settings: responses and commands.<name>", () => {
  test("responses reports which reply list changed", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "responses",
      before: { busy: ["a"], yesNo: ["x"] }, after: { busy: ["a", "b"], yesNo: ["x"] },
    });
    assert.match(msg, /responsesBusyChanged:\{"count":2\}/);
    assert.doesNotMatch(msg, /responsesYesNoChanged/);
  });

  test("responses with no actual diff reports no visible change", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "responses",
      before: { busy: ["a"], yesNo: ["x"] }, after: { busy: ["a"], yesNo: ["x"] },
    });
    assert.equal(msg, "settingsChangeLog.describe.noVisibleChange");
  });

  test("commands.<name> reports enabled + cooldown + signature changes together", () => {
    const msg = describeChange(t, {
      category: "settings", action: "update", target: "commands.settimer",
      before: { enabled: false, cooldownMs: 5000, signature: "!settimer" },
      after: { enabled: true, cooldownMs: 10000, signature: "!timer" },
    });
    assert.match(msg, /commandLabel:\{"name":"settimer"\}/);
    assert.match(msg, /commandEnabled/);
    assert.match(msg, /cooldownChanged:\{"before":5,"after":10\}/);
    assert.match(msg, /signatureChanged:\{"before":"!settimer","after":"!timer"\}/);
  });

  test("unrecognized target still returns a non-JSON fallback", () => {
    const msg = describeChange(t, { category: "settings", action: "update", target: "somethingNew", before: 1, after: 2 });
    assert.equal(msg, "settingsChangeLog.describe.genericChanged");
  });
});
