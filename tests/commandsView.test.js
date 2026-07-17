const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCommand,
  resolveCommandGroups,
  buildCustomCommandsGroup,
  partitionIntoSections,
  formatCooldownMs,
} = require("../lib/commandsView");

describe("formatCooldownMs", () => {
  test("whole seconds render as Ns", () => {
    assert.equal(formatCooldownMs(15000), "15s");
    assert.equal(formatCooldownMs(50000), "50s");
  });

  test("non-whole-second values fall back to ms", () => {
    assert.equal(formatCooldownMs(1500), "1500ms");
  });
});

describe("resolveCommand", () => {
  const baseCmd = { signature: "!addcommand !name text", accessKey: "commands.access.mod", cooldown: null, configKey: "addcommand" };

  test("returns the default signature untouched when no channel is selected", () => {
    const resolved = resolveCommand(baseCmd, null);
    assert.equal(resolved.signature, "!addcommand !name text");
    assert.equal(resolved.enabled, true);
  });

  test("swaps only the leading token when a channel renamed the command", () => {
    const channelCommands = { addcommand: { enabled: true, signature: "!newcmd" } };
    const resolved = resolveCommand(baseCmd, channelCommands);
    assert.equal(resolved.signature, "!newcmd !name text");
  });

  test("marks a command disabled on this channel without dropping it", () => {
    const channelCommands = { addcommand: { enabled: false, signature: "!addcommand" } };
    const resolved = resolveCommand(baseCmd, channelCommands);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.signature, "!addcommand !name text");
  });

  test("resolves a channel's overridden cooldown", () => {
    const cmd = { signature: "!topchatters [day|week|month|all]", accessKey: "commands.access.all", cooldown: "15s", configKey: "topchatters" };
    const channelCommands = { topchatters: { enabled: true, cooldownMs: 30000, signature: "!topchatters" } };
    const resolved = resolveCommand(cmd, channelCommands);
    assert.equal(resolved.cooldown, "30s");
  });

  test("a shared configKey resolves the field it names, e.g. exception's remSignature", () => {
    const cmd = { signature: "!remexception username", accessKey: "commands.access.mod", cooldown: null, configKey: "exception", signatureField: "remSignature" };
    const channelCommands = { exception: { enabled: true, signature: "!addexception", remSignature: "!removeuser" } };
    const resolved = resolveCommand(cmd, channelCommands);
    assert.equal(resolved.signature, "!removeuser username");
  });

  test("noCooldownOverride keeps a row's cooldown even though its configKey has one (muteaccept vs muteduel)", () => {
    const cmd = { signature: "!muteaccept", accessKey: "commands.access.all", cooldown: null, configKey: "muteduel", signatureField: "acceptSignature", noCooldownOverride: true };
    const channelCommands = { muteduel: { enabled: true, cooldownMs: 50000, signature: "!muteduel", acceptSignature: "!muteaccept" } };
    const resolved = resolveCommand(cmd, channelCommands);
    assert.equal(resolved.cooldown, null);
  });

  test("a command with no configKey is left as documented regardless of channel", () => {
    const cmd = { signature: "!customcommands", accessKey: "commands.access.all", cooldown: null };
    const resolved = resolveCommand(cmd, { addcommand: { enabled: false } });
    assert.equal(resolved.signature, "!customcommands");
    assert.equal(resolved.enabled, true);
  });
});

describe("resolveCommandGroups", () => {
  test("resolves every command in every group, preserving group order", () => {
    const groups = [
      { categoryKey: "cat.a", commands: [{ signature: "!a", accessKey: "commands.access.all", cooldown: null, configKey: "a" }] },
      { categoryKey: "cat.b", commands: [{ signature: "!b", accessKey: "commands.access.mod", cooldown: null }] },
    ];
    const resolved = resolveCommandGroups(groups, null);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].categoryKey, "cat.a");
    assert.equal(resolved[1].commands[0].signature, "!b");
  });
});

describe("buildCustomCommandsGroup", () => {
  test("a pinned custom command is mod-only, an unpinned one is open to all", () => {
    const group = buildCustomCommandsGroup([
      { command: "discord", result: "join us: discord.gg/x", pin: false, announce: false, timer: null },
      { command: "rules", result: "be nice", pin: true, announce: false, timer: null },
    ]);
    assert.equal(group.commands[0].accessKey, "commands.access.all");
    assert.equal(group.commands[1].accessKey, "commands.access.mod");
  });

  test("an announced custom command is mod-only too, same as pinned", () => {
    const group = buildCustomCommandsGroup([
      { command: "hype", result: "let's go!", pin: false, announce: true, timer: null },
    ]);
    assert.equal(group.commands[0].accessKey, "commands.access.mod");
  });

  test("truncates a long result and converts the timer from ms to seconds", () => {
    const group = buildCustomCommandsGroup([
      { command: "long", result: "x".repeat(100), pin: false, announce: false, timer: 120000 },
    ]);
    assert.equal(group.commands[0].resultPreview.length, 80);
    assert.ok(group.commands[0].resultPreview.endsWith("…"));
    assert.equal(group.commands[0].timerSeconds, 120);
  });
});

describe("partitionIntoSections", () => {
  test("splits a mixed-access group's rows into everyone vs moderators, both keyed to the same category", () => {
    const resolvedGroups = [
      {
        categoryKey: "commands.category.customCommands",
        commands: [
          { signature: "!addcommand", accessKey: "commands.access.mod" },
          { signature: "!customcommands", accessKey: "commands.access.all" },
        ],
      },
    ];
    const [everyone, moderators] = partitionIntoSections(resolvedGroups);
    assert.equal(everyone.id, "everyone");
    assert.equal(everyone.groups.length, 1);
    assert.equal(everyone.groups[0].commands.length, 1);
    assert.equal(everyone.groups[0].commands[0].signature, "!customcommands");
    assert.equal(everyone.groups[0].anchorId, "everyone-customCommands");

    assert.equal(moderators.id, "moderators");
    assert.equal(moderators.groups[0].commands[0].signature, "!addcommand");
    assert.equal(moderators.groups[0].anchorId, "moderators-customCommands");
  });

  test("a group with only all-access rows produces nothing in the moderators section", () => {
    const resolvedGroups = [
      { categoryKey: "commands.category.chatStats", commands: [{ signature: "!topchatters", accessKey: "commands.access.all" }] },
    ];
    const [everyone, moderators] = partitionIntoSections(resolvedGroups);
    assert.equal(everyone.groups.length, 1);
    assert.equal(moderators.groups.length, 0);
  });
});
