// Pure helpers backing the public /commands reference page (routes/commands.js).
// Kept dependency-free (no i18n, no db) so the resolution/partition logic is
// unit-testable - see tests/commandsView.test.js.
const DEFAULT_COMMANDS_CONFIG = require("../config/defaultChannelConfig.json").commands;

const MOD_ACCESS_KEY = "commands.access.mod";
const ALL_ACCESS_KEY = "commands.access.all";
const CUSTOM_CATEGORY_KEY = "commands.category.channelCustom";

// data/commands.js signatures carry the argument text after the leading token
// (e.g. "!addcommand !name text") - only that leading token is ever overridable
// per-channel, so a rename swaps just it and keeps the rest of the signature intact.
function applySignatureOverride(defaultSignature, defaultToken, overrideToken) {
  if (!defaultToken || !overrideToken || overrideToken === defaultToken) return defaultSignature;
  return defaultSignature.replace(defaultToken, overrideToken);
}

function formatCooldownMs(ms) {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

// Resolves one data/commands.js entry against a channel's ChannelConfig.commands
// (as returned by db/channelConfigRepo.js's getConfig) - or leaves it as the
// documented default when channelCommands is null (no channel selected).
function resolveCommand(cmd, channelCommands) {
  if (!cmd.configKey || !channelCommands) return { ...cmd, enabled: true };

  const conf = channelCommands[cmd.configKey];
  const defaultConf = DEFAULT_COMMANDS_CONFIG[cmd.configKey];
  if (!conf || !defaultConf) return { ...cmd, enabled: true };

  const field = cmd.signatureField || "signature";
  const signature = applySignatureOverride(cmd.signature, defaultConf[field], conf[field]);

  let { cooldown } = cmd;
  if (!cmd.noCooldownOverride && conf.cooldownMs != null) cooldown = formatCooldownMs(conf.cooldownMs);

  return { ...cmd, signature, cooldown, enabled: conf.enabled !== false };
}

function resolveCommandGroups(commandGroups, channelCommands) {
  return commandGroups.map((group) => ({
    categoryKey: group.categoryKey,
    commands: group.commands.map((cmd) => resolveCommand(cmd, channelCommands)),
  }));
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Custom commands are shared-write data from the `custom_commands` collection
// (db/customCommandsRepo.js) - real per-channel data, not a documented default, so
// each row carries a raw resultPreview/pin/announce/timerSeconds instead of the
// descriptionKey/useCaseKey translation keys the rest of the page uses (per
// CLAUDE.md, DB-sourced values are never translated). Triggering a pinned custom
// command is mod-only (pinning replaces the channel's one active pin, a moderation
// action - see TwitchBot/commands/CustomCommands.js), everything else is open to all.
function buildCustomCommandsGroup(customCommands) {
  return {
    categoryKey: CUSTOM_CATEGORY_KEY,
    commands: customCommands.map((c) => ({
      signature: `!${c.command}`,
      accessKey: c.pin ? MOD_ACCESS_KEY : ALL_ACCESS_KEY,
      cooldown: null,
      enabled: true,
      isCustom: true,
      resultPreview: truncate(c.result, 80),
      pin: !!c.pin,
      announce: !!c.announce,
      timerSeconds: c.timer ? Math.round(c.timer / 1000) : null,
    })),
  };
}

function slugFromCategoryKey(categoryKey) {
  return categoryKey.split(".").pop();
}

// Splits every resolved group into an "everyone" and a "moderators" partition by
// row, not by whole group - several categories (e.g. custom commands) mix
// mod-only and all-access rows. A group with rows on both sides ends up
// represented once in each section, same categoryKey but a section-prefixed
// anchorId so the sidebar nav can link to each occurrence independently.
function partitionIntoSections(resolvedGroups) {
  const everyone = [];
  const moderators = [];

  for (const group of resolvedGroups) {
    const everyoneCommands = group.commands.filter((c) => c.accessKey !== MOD_ACCESS_KEY);
    const moderatorCommands = group.commands.filter((c) => c.accessKey === MOD_ACCESS_KEY);
    const slug = slugFromCategoryKey(group.categoryKey);

    if (everyoneCommands.length) {
      everyone.push({ categoryKey: group.categoryKey, anchorId: `everyone-${slug}`, commands: everyoneCommands });
    }
    if (moderatorCommands.length) {
      moderators.push({ categoryKey: group.categoryKey, anchorId: `moderators-${slug}`, commands: moderatorCommands });
    }
  }

  return [
    { id: "everyone", labelKey: "commands.section.everyone", groups: everyone },
    { id: "moderators", labelKey: "commands.section.moderators", groups: moderators },
  ];
}

module.exports = {
  MOD_ACCESS_KEY,
  resolveCommand,
  resolveCommandGroups,
  buildCustomCommandsGroup,
  partitionIntoSections,
  formatCooldownMs,
};
