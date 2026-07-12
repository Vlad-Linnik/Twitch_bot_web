// lib/safeJson.js is a security boundary, not a formatting helper: it serializes chat-derived
// data into a <script> tag on the dashboards. Twitch chat is attacker-controlled, so a regression
// here is a stored-XSS hole. These tests pin the two escapes that matter.
const test = require("node:test");
const assert = require("node:assert/strict");
const safeJson = require("../lib/safeJson");

const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

test("neutralises a </script> breakout from a chat message", () => {
  const payload = { words: [{ word: "</script><img src=x onerror=alert(1)>", count: 3 }] };
  const out = safeJson(payload);

  assert.ok(!out.includes("</script>"), "raw </script> must not survive serialization");
  assert.ok(out.includes("\\u003c"), "< must be escaped as \\u003c");
});

test("escapes U+2028/U+2029, which are valid JSON but break JS source", () => {
  const out = safeJson({ message: `a${LINE_SEP}b${PARA_SEP}c` });

  const hasRawSeparator = [...out].some((c) => c.charCodeAt(0) === 0x2028 || c.charCodeAt(0) === 0x2029);
  assert.equal(hasRawSeparator, false);
});

test("output is still valid JSON and round-trips to the original value", () => {
  // The escaping must be lossless - JSON.parse() turns \uXXXX back into the real characters, so
  // the browser sees exactly what the server meant, just not as executable markup.
  const original = {
    words: [{ word: "</script>", count: 1 }],
    message: `a${LINE_SEP}b`,
    nested: { nickname: "<b>bold</b>" },
  };

  const parsed = JSON.parse(safeJson(original));
  assert.deepEqual(parsed, original);
});

test("leaves ordinary content untouched", () => {
  assert.equal(safeJson({ word: "привет", count: 5 }), '{"word":"привет","count":5}');
});
