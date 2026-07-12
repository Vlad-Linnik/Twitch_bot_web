// The display-colour policy was previously written out longhand in middleware/navMenu.js and
// again in routes/about.js, while routes/userDashboard.js skipped the custom-colour override
// entirely - so a user who picked a custom colour saw it in the nav and on /about, but their raw
// Twitch colour on their own profile page. These tests pin the single policy that replaced it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDisplayColor } = require("../db/userProfileService");

test("a custom colour wins when the user opted into it", () => {
  const prefs = { chatColorMode: "custom", customChatColor: "#ff0000" };
  const profile = { chatColor: "#9ACD32" };
  assert.equal(resolveDisplayColor(prefs, profile), "#ff0000");
});

test("switching back to Twitch mode restores the real chat colour", () => {
  // The stale custom value is still on the document - opting out must not keep using it.
  const prefs = { chatColorMode: "twitch", customChatColor: "#ff0000" };
  const profile = { chatColor: "#9ACD32" };
  assert.equal(resolveDisplayColor(prefs, profile), "#9ACD32");
});

test("custom mode with no colour set falls back rather than rendering nothing", () => {
  const prefs = { chatColorMode: "custom", customChatColor: null };
  const profile = { chatColor: "#9ACD32" };
  assert.equal(resolveDisplayColor(prefs, profile), "#9ACD32");
});

test("no preferences at all: the Twitch colour is used", () => {
  assert.equal(resolveDisplayColor(null, { chatColor: "#9ACD32" }), "#9ACD32");
  assert.equal(resolveDisplayColor(undefined, { chatColor: "#9ACD32" }), "#9ACD32");
});

test("nothing known: null, so the caller renders the name undecorated", () => {
  // Must be null, not "" or "inherit" - the views branch on truthiness to decide whether to emit
  // a style attribute at all.
  assert.equal(resolveDisplayColor(null, null), null);
  assert.equal(resolveDisplayColor({}, {}), null);
});
