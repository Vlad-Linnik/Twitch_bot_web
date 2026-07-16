// Hand-maintained, kept in sync with TwitchBot/COMMANDS.md whenever a
// command is added/changed there. Deliberately not fetched cross-repo (see
// PLAN.md) - update both files together when the bot's command set changes.
//
// `cooldown` mirrors TwitchBot/config/channelSettings.js's DEFAULT_CHANNEL_SETTINGS
// cooldownMs (null where the command has no configurable cooldown). `descriptionKey`/
// `useCaseKey`/`categoryKey`/`accessKey` are config/locales/*.json paths, resolved
// via t() in commands.ejs so descriptions translate along with the rest of the site.
//
// `configKey` names the matching key under ChannelConfig.commands (see
// config/defaultChannelConfig.json) so lib/commandsView.js can resolve a channel's
// actual signature/cooldown/enabled state on top of these defaults - omit it for
// commands with no per-channel override (e.g. !customcommands, !counters). Some
// commands share a configKey but read a different field of it (`signatureField`,
// default "signature") - !remexception reads `exception.remSignature`, !muteaccept
// reads `muteduel.acceptSignature`. `noCooldownOverride` opts a row out of cooldown
// resolution even though its configKey has a cooldownMs field that belongs to a
// sibling row sharing the same key (muteduel's cooldownMs governs !muteduel, not
// !muteaccept).
module.exports = [
  {
    categoryKey: "commands.category.customCommands",
    commands: [
      { signature: "!addcommand !name text", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addcommand", useCaseKey: "commands.useCase.addcommand", configKey: "addcommand" },
      { signature: "!delcommand !name", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.delcommand", useCaseKey: "commands.useCase.delcommand", configKey: "delcommand" },
      { signature: "!settimer !name <seconds>|off", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.settimer", useCaseKey: "commands.useCase.settimer", configKey: "settimer" },
      { signature: "!setpin !name on|off", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.setpin", useCaseKey: "commands.useCase.setpin", configKey: "setpin" },
      { signature: "!setannounce !name on|off", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.setannounce", useCaseKey: "commands.useCase.setannounce", configKey: "setannounce" },
      { signature: "!customcommands", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.customcommands", useCaseKey: "commands.useCase.customcommands" },
      { signature: "!name", accessKey: "commands.access.allPinExempt", cooldown: null, descriptionKey: "commands.desc.triggerCustom", useCaseKey: "commands.useCase.triggerCustom" },
    ],
  },
  {
    categoryKey: "commands.category.counters",
    commands: [
      { signature: "!addcounter #name [mod]", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addcounter", useCaseKey: "commands.useCase.addcounter", configKey: "addcounter" },
      { signature: "!delcounter #name", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.delcounter", useCaseKey: "commands.useCase.delcounter", configKey: "delcounter" },
      { signature: "!counters", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.counters", useCaseKey: "commands.useCase.counters" },
      { signature: "#name / #name + N / #name - N", accessKey: "commands.access.allExceptionListed", cooldown: "10s", descriptionKey: "commands.desc.counterUpdate", useCaseKey: "commands.useCase.counterUpdate", configKey: "counterUpdate" },
      { signature: "!addexception username", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addexception", useCaseKey: "commands.useCase.addexception", configKey: "exception", signatureField: "signature" },
      { signature: "!remexception username", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.remexception", useCaseKey: "commands.useCase.remexception", configKey: "exception", signatureField: "remSignature" },
    ],
  },
  {
    categoryKey: "commands.category.chatStats",
    commands: [
      { signature: "!topchatters [day|week|month|all]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.topchatters", useCaseKey: "commands.useCase.topchatters", configKey: "topchatters" },
      { signature: "!topsmiles [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.topsmiles", useCaseKey: "commands.useCase.topsmiles", configKey: "topsmiles" },
      { signature: "!countword <word>", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countword", useCaseKey: "commands.useCase.countword", configKey: "countword" },
      { signature: "!countmsg [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countmsg", useCaseKey: "commands.useCase.countmsg", configKey: "countmsg" },
      { signature: "!countunique [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countunique", useCaseKey: "commands.useCase.countunique", configKey: "countunique" },
      { signature: "!botinfo", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.botinfo", useCaseKey: "commands.useCase.botinfo", configKey: "botinfo" },
      { signature: "!randomclip", accessKey: "commands.access.all", cooldown: "30s", descriptionKey: "commands.desc.randomclip", useCaseKey: "commands.useCase.randomclip", configKey: "randomclip" },
    ],
  },
  {
    categoryKey: "commands.category.moderation",
    commands: [
      { signature: "!update7tv", accessKey: "commands.access.mod", cooldown: "30s", descriptionKey: "commands.desc.update7tv", useCaseKey: "commands.useCase.update7tv", configKey: "update7tv" },
    ],
  },
  {
    categoryKey: "commands.category.miniGames",
    commands: [
      { signature: "!muteduel [@user] [seconds]", accessKey: "commands.access.all", cooldown: "50s", descriptionKey: "commands.desc.muteduel", useCaseKey: "commands.useCase.muteduel", configKey: "muteduel", signatureField: "signature" },
      { signature: "!muteaccept", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.muteaccept", useCaseKey: "commands.useCase.muteaccept", configKey: "muteduel", signatureField: "acceptSignature", noCooldownOverride: true },
      { signature: "!совет", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.sovet", useCaseKey: "commands.useCase.sovet" },
    ],
  },
];
