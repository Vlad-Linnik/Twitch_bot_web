const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolvePrivacy } = require("../lib/privacy");

test("no preferences doc: charts hidden by default, profile visible", () => {
  assert.deepEqual(resolvePrivacy(null), {
    hideMessageVolume: true,
    hideChatActivity: true,
    hideProfile: false,
  });
  assert.deepEqual(resolvePrivacy(undefined), resolvePrivacy(null));
});

test("doc without privacy fields (pre-feature user) gets the same defaults", () => {
  assert.deepEqual(resolvePrivacy({ locale: "ru", updatedAt: new Date() }), {
    hideMessageVolume: true,
    hideChatActivity: true,
    hideProfile: false,
  });
});

test("explicit false overrides the hidden-by-default charts", () => {
  const privacy = resolvePrivacy({ hideMessageVolume: false, hideChatActivity: false });
  assert.equal(privacy.hideMessageVolume, false);
  assert.equal(privacy.hideChatActivity, false);
  assert.equal(privacy.hideProfile, false);
});

test("explicit true hides the profile", () => {
  assert.equal(resolvePrivacy({ hideProfile: true }).hideProfile, true);
});
