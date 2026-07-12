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
  assert.deepEqual(res.command, { command: "discord", result: "https://discord.gg/x", timer: null, pin: false });
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
