const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_LIST_ITEMS,
  sanitizeStringList,
  sanitizeWord,
  sanitizeSignatureWord,
  parseCooldownSeconds,
  parseMinMessages,
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

describe("parseCooldownSeconds", () => {
  test("accepts whole seconds within range", () => {
    assert.equal(parseCooldownSeconds("15"), 15);
    assert.equal(parseCooldownSeconds(0), 0);
    assert.equal(parseCooldownSeconds("86400"), 86400);
  });

  test("returns null (keep existing) for invalid or out-of-range input", () => {
    assert.equal(parseCooldownSeconds(""), null);
    assert.equal(parseCooldownSeconds(undefined), null);
    assert.equal(parseCooldownSeconds("abc"), null);
    assert.equal(parseCooldownSeconds("-5"), null);
    assert.equal(parseCooldownSeconds("86401"), null);
  });
});

describe("parseMinMessages", () => {
  test("accepts integers within range", () => {
    assert.equal(parseMinMessages("10"), 10);
    assert.equal(parseMinMessages("0"), 0);
  });

  test("returns null (keep existing) for invalid or out-of-range input", () => {
    assert.equal(parseMinMessages(""), null);
    assert.equal(parseMinMessages("-1"), null);
    assert.equal(parseMinMessages("1001"), null);
  });
});

describe("parseSubmittedConfig", () => {
  const existing = {
    bannedWords: { words: ["badword"], timeoutReason: "no spam" },
    spamSignatures: ["sig1"],
    spamBanReason: "spam bot",
    commands: {
      topchatters: { enabled: true, cooldownMs: 15000, signature: "!topchatters" },
      question: { enabled: true, cooldownMs: 30000 },
      insult: { enabled: true, cumulativeDelayMs: 150000 },
      customCommandTimer: { minMessagesBetween: 10 },
    },
    responses: {
      insultModExempt: ["("],
      insufficientPermissions: "no mod rights",
    },
  };

  test("auto-prepends ! to a bare signature submission", () => {
    const body = {
      "commands.topchatters.present": "1",
      "commands.topchatters.enabled": "on",
      "commands.topchatters.signature": "renamedcommand",
    };
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.topchatters.signature, "!renamedcommand");
  });

  test("a blank signature submission keeps the existing signature (never wipes it)", () => {
    const body = {
      "commands.topchatters.present": "1",
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

  test("an unchecked toggle disables the command only when its .present marker was submitted", () => {
    const body = { "commands.topchatters.present": "1" }; // checkbox omitted = unchecked
    const result = parseSubmittedConfig(body, existing);
    assert.equal(result.commands.topchatters.enabled, false);
  });

  test("a toggle NOT on the form (no .present marker) keeps its stored enabled flag", () => {
    // insult's toggle lives on the Banned Words page - saving the main settings form
    // must never flip it off just because it wasn't submitted.
    const result = parseSubmittedConfig({}, existing);
    assert.equal(result.commands.insult.enabled, true);
  });

  test("cooldown is edited in seconds, stored in ms; invalid input keeps the stored value", () => {
    const good = parseSubmittedConfig({ "commands.question.cooldownSeconds": "45" }, existing);
    assert.equal(good.commands.question.cooldownMs, 45000);

    const bad = parseSubmittedConfig({ "commands.question.cooldownSeconds": "nope" }, existing);
    assert.equal(bad.commands.question.cooldownMs, 30000);
  });

  test("customCommandTimer.minMessagesBetween is editable; invalid input keeps the stored value", () => {
    const good = parseSubmittedConfig({ "commands.customCommandTimer.minMessagesBetween": "25" }, existing);
    assert.equal(good.commands.customCommandTimer.minMessagesBetween, 25);

    const bad = parseSubmittedConfig({ "commands.customCommandTimer.minMessagesBetween": "-3" }, existing);
    assert.equal(bad.commands.customCommandTimer.minMessagesBetween, 10);
  });

  test("bannedWords, spamSignatures, and spamBanReason are carried over unchanged, not parsed from the body", () => {
    const result = parseSubmittedConfig({ spamBanReason: "attacker-controlled" }, existing);
    assert.equal(result.bannedWords, existing.bannedWords);
    assert.equal(result.spamSignatures, existing.spamSignatures);
    assert.equal(result.spamBanReason, "spam bot");
  });

  test("system responses (insultModExempt, insufficientPermissions) are preserved, never form-editable", () => {
    const body = {
      insultModExempt: "malicious\nlines",
      insufficientPermissions: "malicious",
    };
    const result = parseSubmittedConfig(body, existing);
    assert.deepEqual(result.responses.insultModExempt, ["("]);
    assert.equal(result.responses.insufficientPermissions, "no mod rights");
  });

  test("response textareas are split into sanitized lists", () => {
    const body = { busyResponses: "one\ntwo\n\nthree  " };
    const result = parseSubmittedConfig(body, existing);
    assert.deepEqual(result.responses.busy, ["one", "two", "three"]);
  });
});
