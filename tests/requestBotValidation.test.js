const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRequestForm, MESSAGE_MAX_LENGTH } = require("../lib/requestBotValidation");

test("accepts a form with the mod acknowledgement and no message", () => {
  const res = parseRequestForm({ modAcknowledged: "on" });
  assert.equal(res.ok, true);
  assert.equal(res.message, "");
});

test("trims the optional message", () => {
  const res = parseRequestForm({ modAcknowledged: "on", message: "  please add the bot  " });
  assert.equal(res.ok, true);
  assert.equal(res.message, "please add the bot");
});

test("rejects when the mod-rights acknowledgement is missing", () => {
  // The checkbox is `required` in the markup, but a hand-crafted POST must not bypass it.
  for (const body of [{}, { modAcknowledged: "" }, { modAcknowledged: "true" }, { message: "hi" }]) {
    assert.equal(parseRequestForm(body).error, "mod_ack_required");
  }
});

test("rejects an over-long message", () => {
  const res = parseRequestForm({ modAcknowledged: "on", message: "a".repeat(MESSAGE_MAX_LENGTH + 1) });
  assert.equal(res.error, "message_too_long");
});

test("tolerates a non-string message field", () => {
  const res = parseRequestForm({ modAcknowledged: "on", message: ["array"] });
  assert.equal(res.ok, true);
  assert.equal(res.message, "");
});
