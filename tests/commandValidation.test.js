// The web panel writes the SAME `custom_commands` collection the bot reads and executes. So these
// rules aren't UI polish - anything the panel lets through that !addcommand/!settimer would have
// rejected is a way to create a command chat itself could never have created, which the bot then
// runs. Each test below mirrors a check in TwitchBot/commands/CustomCommands.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand, normalizeName } = require("../lib/commandValidation");

test("normalizeName strips a leading ! and lowercases", () => {
  assert.equal(normalizeName("!Hello"), "hello");
  assert.equal(normalizeName("  ПРИВЕТ "), "привет");
});

test("accepts a plain command", () => {
  const res = parseCommand({ name: "!discord", result: "https://discord.gg/x" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.command, {
    command: "discord", result: "https://discord.gg/x", timer: null, pin: false, announce: false,
    announceColor: "primary", enabled: false, categoryTexts: [],
  });
});

test("enabled follows the same on/absent convention as pin/announce", () => {
  assert.equal(parseCommand({ name: "x", result: "y" }).command.enabled, false);
  assert.equal(parseCommand({ name: "x", result: "y", enabled: "on" }).command.enabled, true);
});

test("accepts Cyrillic names, like the bot's own matcher does", () => {
  assert.equal(parseCommand({ name: "правила", result: "текст" }).ok, true);
});

test("rejects names the bot's matcher would never produce", () => {
  // The bot matches /!([a-zа-я0-9]+)/. A name with a space, a dot or a regex metacharacter could
  // never be created in chat - and would end up inside a matcher here.
  for (const bad of ["my command", "cmd.name", "a+b", "war*", "hi!", ""]) {
    const res = parseCommand({ name: bad, result: "x" });
    assert.equal(res.ok, false, `"${bad}" should be rejected`);
  }
});

test("requires response text", () => {
  assert.equal(parseCommand({ name: "x", result: "   " }).error, "result_required");
});

test("rejects a response too long for a Twitch message", () => {
  const res = parseCommand({ name: "x", result: "a".repeat(600) });
  assert.equal(res.error, "result_too_long");
});

test("converts the timer from seconds to the milliseconds the bot stores", () => {
  // The chat command takes seconds and multiplies by 1000; the collection holds ms. Writing
  // seconds into that field would make a 120s timer fire every 120ms.
  const res = parseCommand({ name: "x", result: "y", timerSeconds: "120" });
  assert.equal(res.command.timer, 120000);
});

test("enforces the bot's 60-second minimum timer", () => {
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "30" }).error, "timer_too_short");
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "60" }).ok, true);
});

test("'off' and empty both mean no timer", () => {
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "off" }).command.timer, null);
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "" }).command.timer, null);
});

test("refuses timer + pin together, exactly as the bot does", () => {
  // Twitch allows one active pinned message per channel, and a timered command re-pins on every
  // auto-post. setCommandTimer/setCommandPin both reject this pair in chat.
  const res = parseCommand({ name: "x", result: "y", timerSeconds: "120", pin: "on" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "timer_and_pin");

  // ...but each alone is fine.
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "120" }).ok, true);
  assert.equal(parseCommand({ name: "x", result: "y", pin: "on" }).command.pin, true);
});

test("refuses announce + pin together, exactly as the bot does", () => {
  // An announcement is a self-contained Helix send with no message ID to pin -
  // setCommandAnnounce/setCommandPin both reject this pair in chat.
  const res = parseCommand({ name: "x", result: "y", pin: "on", announce: "on" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "announce_and_pin");

  // ...but a timer + announce together is exactly the point of the feature.
  assert.equal(parseCommand({ name: "x", result: "y", timerSeconds: "120", announce: "on" }).ok, true);
});

test("defaults to the primary announcement color and rejects unknown ones", () => {
  assert.equal(parseCommand({ name: "x", result: "y", announce: "on" }).command.announceColor, "primary");
  assert.equal(parseCommand({ name: "x", result: "y", announce: "on", announceColor: "blue" }).command.announceColor, "blue");
  assert.equal(parseCommand({ name: "x", result: "y", announce: "on", announceColor: "not-a-color" }).command.announceColor, "primary");
});

test("category overrides: blank rows are dropped, filled rows are kept", () => {
  const res = parseCommand({
    name: "x", result: "default text",
    categoryTexts: [{ category: "", result: "" }, { category: "Dota 2", result: "gl hf" }, { category: "", result: "" }],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.command.categoryTexts, [{ category: "Dota 2", result: "gl hf" }]);
});

test("category overrides: a row with only one side filled in is rejected, not silently dropped", () => {
  assert.equal(
    parseCommand({ name: "x", result: "y", categoryTexts: [{ category: "Dota 2", result: "" }] }).error,
    "category_result_required"
  );
  assert.equal(
    parseCommand({ name: "x", result: "y", categoryTexts: [{ category: "", result: "gl hf" }] }).error,
    "category_required"
  );
});

test("category overrides: rejects a result too long for a Twitch message", () => {
  const res = parseCommand({ name: "x", result: "y", categoryTexts: [{ category: "Dota 2", result: "a".repeat(600) }] });
  assert.equal(res.error, "category_result_too_long");
});

test("category overrides: rejects a duplicate category (case-insensitive)", () => {
  const res = parseCommand({
    name: "x", result: "y",
    categoryTexts: [{ category: "Dota 2", result: "a" }, { category: "dota 2", result: "b" }],
  });
  assert.equal(res.error, "category_duplicate");
});

test("category overrides: caps the number of rows", () => {
  const categoryTexts = Array.from({ length: 6 }, (_, i) => ({ category: `Game ${i}`, result: "text" }));
  const res = parseCommand({ name: "x", result: "y", categoryTexts });
  assert.equal(res.error, "category_overrides_too_many");
});

test("category overrides: default to an empty list when omitted", () => {
  assert.deepEqual(parseCommand({ name: "x", result: "y" }).command.categoryTexts, []);
});
