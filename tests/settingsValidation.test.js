const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_LIST_ITEMS,
  sanitizeStringList,
  sanitizeWord,
  sanitizeSignatureWord,
  isValidHttpUrl,
  parseSubmittedConfig,
} = require("../lib/settingsValidation");

describe("sanitizeStringList", () => {
  test("trims, drops blanks, and caps length", () => {
    assert.deepEqual(sanitizeStringList(["  a  ", "", "b", "   "]), ["a", "b"]);
  });

  test("drops non-string entries", () => {
    assert.deepEqual(sanitizeStringList(["a", 5, null, "b"]), ["a", "b"]);
  });

  test("non-array input returns an empty list", () => {
    assert.deepEqual(sanitizeStringList("not an array"), []);
    assert.deepEqual(sanitizeStringList(undefined), []);
  });

  test("caps at MAX_LIST_ITEMS entries", () => {
    const input = Array.from({ length: MAX_LIST_ITEMS + 10 }, (_, i) => `item${i}`);
    assert.equal(sanitizeStringList(input).length, MAX_LIST_ITEMS);
  });
});

describe("sanitizeWord", () => {
  test("trims whitespace", () => {
    assert.equal(sanitizeWord("  hello  "), "hello");
  });

  test("handles missing/falsy input", () => {
    assert.equal(sanitizeWord(undefined), "");
    assert.equal(sanitizeWord(null), "");
    assert.equal(sanitizeWord(""), "");
  });

  test("coerces non-string input to a string", () => {
    assert.equal(sanitizeWord(123), "123");
  });
});

describe("sanitizeSignatureWord", () => {
  // Regression coverage for the bug where the site let a command signature be
  // saved without its leading "!", silently breaking the bot's trigger match.
  test("strips a redundant leading ! the user typed anyway", () => {
    assert.equal(sanitizeSignatureWord("!topchatters"), "topchatters");
    assert.equal(sanitizeSignatureWord("!!!topchatters"), "topchatters");
  });

  test("passes a bare word through unchanged", () => {
    assert.equal(sanitizeSignatureWord("topchatters"), "topchatters");
  });

  test("keeps only the first whitespace-delimited token", () => {
    assert.equal(sanitizeSignatureWord("top chatters"), "top");
    assert.equal(sanitizeSignatureWord("  top   chatters  "), "top");
  });

  test("empty, whitespace-only, or prefix-only input returns empty (caller must keep the existing signature)", () => {
    assert.equal(sanitizeSignatureWord(""), "");
    assert.equal(sanitizeSignatureWord("   "), "");
    assert.equal(sanitizeSignatureWord("!!!"), "");
    assert.equal(sanitizeSignatureWord(undefined), "");
  });

  test("caps overly long signatures", () => {
    const result = sanitizeSignatureWord("a".repeat(50));
    assert.ok(result.length <= 30);
  });

  test("supports non-Latin scripts", () => {
    assert.equal(sanitizeSignatureWord("рулетка"), "рулетка");
  });
});

describe("isValidHttpUrl", () => {
  test("accepts http and https URLs", () => {
    assert.equal(isValidHttpUrl("http://example.com"), true);
    assert.equal(isValidHttpUrl("https://7tv.app/users/abc123"), true);
  });

  test("accepts an empty value (field is optional)", () => {
    assert.equal(isValidHttpUrl(""), true);
    assert.equal(isValidHttpUrl(undefined), true);
  });

  test("rejects non-http(s) protocols and malformed URLs", () => {
    assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
    assert.equal(isValidHttpUrl("ftp://example.com"), false);
    assert.equal(isValidHttpUrl("not a url"), false);
  });
});

describe("parseSubmittedConfig", () => {
  const existing = {
    bannedWords: { words: ["badword"], timeoutReason: "no spam" },
    spamSignatures: ["sig1"],
    commands: {
      topchatters: { enabled: true, signature: "!topchatters" },
      question: { enabled: true },
    },
  };

  test("auto-prepends ! to a bare signature submission", () => {
    const body = {
      "commands.topchatters.enabled": "on",
      "commands.topchatters.signature": "renamedcommand",
    };
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.topchatters.signature, "!renamedcommand");
  });

  test("a blank signature submission keeps the existing signature (never wipes it)", () => {
    const body = {
      "commands.topchatters.enabled": "on",
      "commands.topchatters.signature": "   ",
    };
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.topchatters.signature, "!topchatters");
  });

  test("a command with no signature field stays without one", () => {
    const body = {};
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.question.signature, undefined);
  });

  test("enabled reflects the checkbox's presence, not just truthiness", () => {
    const body = {}; // checkbox omitted entirely = unchecked
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.topchatters.enabled, false);
  });

  test("bannedWords and spamSignatures are carried over unchanged, not parsed from the body", () => {
    const result = parseSubmittedConfig({}, existing);
    assert.equal(result.bannedWords, existing.bannedWords);
    assert.equal(result.spamSignatures, existing.spamSignatures);
  });

  test("response textareas are split into sanitized lists", () => {
    const body = { busyResponses: "one\ntwo\n\nthree  " };
    const result = parseSubmittedConfig(body, existing);
    assert.deepEqual(result.responses.busy, ["one", "two", "three"]);
  });
});
