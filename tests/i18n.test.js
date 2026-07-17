const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { translate } = require("../config/i18n");

describe("translate", () => {
  test("returns the plain string for a key with no vars", () => {
    assert.equal(translate("en", "settingsChangeLog.title"), "Change log");
  });

  test("fills in {{placeholders}} from vars", () => {
    assert.equal(
      translate("en", "settingsChangeLog.describe.commandAdded", { name: "site" }),
      "Command !site added"
    );
  });

  test("leaves an unmatched placeholder untouched instead of throwing", () => {
    assert.equal(
      translate("en", "settingsChangeLog.describe.commandAdded", { wrongKey: "site" }),
      "Command !{{name}} added"
    );
  });

  test("a missing key still falls back to the raw key, vars or not", () => {
    assert.equal(translate("en", "settingsChangeLog.notARealKey", { foo: "bar" }), "settingsChangeLog.notARealKey");
  });
});
