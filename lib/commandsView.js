// Pure helpers backing the public /commands reference page (routes/commands.js).
// Kept dependency-free (no i18n, no db) so the resolution/partition logic is
// unit-testable - see tests/commandsView.test.js.
const DEFAULT_COMMANDS_CONFIG = require("../config/defaultChannelConfig.json").commands;

const MOD_ACCESS_KEY = "commands.access.mod";
const ALL_ACCESS_KEY = "commands.access.all";
const CUSTOM_CATEGORY_KEY = "commands.category.channelCustom";
const CUSTOM_UNGROUPED_KEY = "commands.category.channelCustomUngrouped";

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

// Mirrors the bot's own pick, TwitchBot/commands/CustomCommands.js's resolveCommandText: a
// category override whose name matches the stream's CURRENT category (case-insensitive - mods
// type it freely on the web panel), or null when there's no live category or no matching
// override, in which case the caller falls back to the command's plain `result`.
function resolveCategoryOverride(cmd, currentCategory) {
  if (!currentCategory || !cmd.categoryTexts || !cmd.categoryTexts.length) return null;
  const match = cmd.categoryTexts.find((ct) => ct.category.toLowerCase() === currentCategory.toLowerCase());
  return match ? match.result : null;
}

// Custom commands are shared-write data from the `custom_commands` collection
// (db/customCommandsRepo.js) - real per-channel data, not a documented default, so
// each row carries a raw resultPreview/pin/announce/timerSeconds instead of the
// descriptionKey/useCaseKey translation keys the rest of the page uses (per
// CLAUDE.md, DB-sourced values are never translated). Triggering a pinned OR announced
// custom command is mod-only (pinning replaces the channel's one active pin; an
// announcement is a highlighted, colored system-style message - both moderation-flavored
// actions, see TwitchBot/commands/CustomCommands.js), everything else is open to all.
//
// `currentCategory` is the channel's live Twitch stream category (or null offline/unknown,
// see twitch/currentCategory.js) - a command whose categoryTexts includes an override matching
// it shows that override's text instead of its base `result`, same as what would actually fire
// in chat right now (activeCategory flags the row so the view can badge it).
//
// `modOnly` (a web-panel-only field) restricts manual triggering to mods too, so it lands the row
// in the moderators section like pin/announce do. `enabled: false` is a command the bot skips.
function toCustomRow(c, currentCategory) {
  const override = resolveCategoryOverride(c, currentCategory);
  return {
    signature: `!${c.command}`,
    accessKey: (c.pin || c.announce || c.modOnly) ? MOD_ACCESS_KEY : ALL_ACCESS_KEY,
    cooldown: null,
    enabled: c.enabled !== false,
    isCustom: true,
    resultPreview: override || c.result,
    activeCategory: override ? currentCategory : null,
    pin: !!c.pin,
    announce: !!c.announce,
    timerSeconds: c.timer ? Math.round(c.timer / 1000) : null,
  };
}

// One group per `group` label the channel's mods assigned on the custom-commands settings page,
// in that page's order (routes/customCommands.js's buildCommandsView): named groups
// alphabetically, then the ungrouped commands. A named group's heading is the label itself -
// DB-sourced, so `title` is shown verbatim instead of a translated categoryKey. With no named
// groups at all the single group keeps its old heading.
function buildCustomCommandsGroups(customCommands, currentCategory) {
  const names = [...new Set(customCommands.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const groups = names.map((name, i) => ({
    categoryKey: CUSTOM_CATEGORY_KEY,
    title: name,
    slug: `custom-${i + 1}`,
    isCustom: true,
    commands: customCommands.filter((c) => c.group === name).map((c) => toCustomRow(c, currentCategory)),
  }));
  const ungrouped = customCommands.filter((c) => !c.group);
  if (ungrouped.length) {
    groups.push({
      categoryKey: names.length ? CUSTOM_UNGROUPED_KEY : CUSTOM_CATEGORY_KEY,
      slug: "channelCustom",
      isCustom: true,
      commands: ungrouped.map((c) => toCustomRow(c, currentCategory)),
    });
  }
  return groups;
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
    const slug = group.slug || slugFromCategoryKey(group.categoryKey);
    const base = { categoryKey: group.categoryKey, title: group.title || null, isCustom: !!group.isCustom };

    if (everyoneCommands.length) {
      everyone.push({ ...base, anchorId: `everyone-${slug}`, commands: everyoneCommands });
    }
    if (moderatorCommands.length) {
      moderators.push({ ...base, anchorId: `moderators-${slug}`, commands: moderatorCommands });
    }
  }

  return [
    { id: "everyone", labelKey: "commands.section.everyone", groups: everyone },
    { id: "moderators", labelKey: "commands.section.moderators", groups: moderators },
  ];
}

// What a viewer without moderator rights on the channel sees: only the commands that actually
// answer in chat. A group left with nothing in it disappears rather than showing an empty table.
function dropDisabled(groups) {
  return groups
    .map((g) => ({ ...g, commands: g.commands.filter((c) => c.enabled !== false) }))
    .filter((g) => g.commands.length);
}

module.exports = {
  dropDisabled,
  MOD_ACCESS_KEY,
  resolveCommand,
  resolveCommandGroups,
  buildCustomCommandsGroups,
  partitionIntoSections,
  formatCooldownMs,
};
