const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DURATION_PRESETS,
  parseDuration,
  sanitizeReason,
  normalizeSignatureEntry,
  parseSignatureEntry,
} = require("../lib/spamSignatureValidation");

test("parseDuration: empty or 'permanent' means no timeout at all", () => {
  assert.deepEqual(parseDuration(""), { ok: true, durationSeconds: null });
  assert.deepEqual(parseDuration("permanent"), { ok: true, durationSeconds: null });
});

test("parseDuration: accepts each preset in seconds", () => {
  for (const { seconds } of DURATION_PRESETS) {
    assert.deepEqual(parseDuration(String(seconds)), { ok: true, durationSeconds: seconds });
  }
});

test("parseDuration: rejects a value that isn't a known preset", () => {
  // Never trust the request body - only the site's own <select> options are valid, not an
  // arbitrary number of seconds someone could POST directly.
  assert.equal(parseDuration("42").ok, false);
  assert.equal(parseDuration("not a number").ok, false);
});

test("sanitizeReason: blank means 'use the shared spamBanReason'", () => {
  assert.equal(sanitizeReason(""), null);
  assert.equal(sanitizeReason("   "), null);
  assert.equal(sanitizeReason(undefined), null);
});

test("sanitizeReason: trims and caps length", () => {
  assert.equal(sanitizeReason("  custom reason  "), "custom reason");
  assert.equal(sanitizeReason("a".repeat(600)).length, 500);
});

test("normalizeSignatureEntry: a pre-migration bare string means permanent + shared reason", () => {
  assert.deepEqual(normalizeSignatureEntry("subscribe to my channel"), {
    word: "subscribe to my channel", durationSeconds: null, reason: null,
  });
});

test("normalizeSignatureEntry: an existing object entry passes through, filling in missing fields", () => {
  assert.deepEqual(normalizeSignatureEntry({ word: "spam", durationSeconds: 3600, reason: "spam link" }), {
    word: "spam", durationSeconds: 3600, reason: "spam link",
  });
  assert.deepEqual(normalizeSignatureEntry({ word: "spam" }), { word: "spam", durationSeconds: null, reason: null });
});

test("parseSignatureEntry: requires a non-blank word", () => {
  assert.equal(parseSignatureEntry({ word: "  ", duration: "", reason: "" }).error, "signature_required");
});

test("parseSignatureEntry: rejects an invalid duration", () => {
  assert.equal(parseSignatureEntry({ word: "spam", duration: "99", reason: "" }).error, "duration_invalid");
});

test("parseSignatureEntry: builds a full entry with a custom duration and reason", () => {
  const res = parseSignatureEntry({ word: "spam link", duration: "604800", reason: "known spam signature" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entry, { word: "spam link", durationSeconds: 604800, reason: "known spam signature" });
});

test("parseSignatureEntry: defaults to permanent + shared reason when neither is given", () => {
  const res = parseSignatureEntry({ word: "spam link", duration: "", reason: "" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entry, { word: "spam link", durationSeconds: null, reason: null });
});
