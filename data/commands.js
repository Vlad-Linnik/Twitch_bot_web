// Hand-maintained, kept in sync with TwitchBot/COMMANDS.md whenever a
// command is added/changed there. Deliberately not fetched cross-repo (see
// PLAN.md) - update both files together when the bot's command set changes.
//
// `cooldown` mirrors TwitchBot/config/channelSettings.js's DEFAULT_CHANNEL_SETTINGS
// cooldownMs (null where the command has no configurable cooldown). `descriptionKey`/
// `useCaseKey`/`categoryKey`/`accessKey` are config/locales/*.json paths, resolved
// via t() in commands.ejs so descriptions translate along with the rest of the site.
module.exports = [
  {
    categoryKey: "commands.category.customCommands",
    commands: [
      { signature: "!addcommand !name text", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addcommand", useCaseKey: "commands.useCase.addcommand" },
      { signature: "!delcommand !name", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.delcommand", useCaseKey: "commands.useCase.delcommand" },
      { signature: "!settimer !name <seconds>|off", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.settimer", useCaseKey: "commands.useCase.settimer" },
      { signature: "!setpin !name on|off", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.setpin", useCaseKey: "commands.useCase.setpin" },
      { signature: "!customcommands", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.customcommands", useCaseKey: "commands.useCase.customcommands" },
      { signature: "!name", accessKey: "commands.access.allPinExempt", cooldown: null, descriptionKey: "commands.desc.triggerCustom", useCaseKey: "commands.useCase.triggerCustom" },
    ],
  },
  {
    categoryKey: "commands.category.counters",
    commands: [
      { signature: "!addcounter #name [mod]", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addcounter", useCaseKey: "commands.useCase.addcounter" },
      { signature: "!delcounter #name", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.delcounter", useCaseKey: "commands.useCase.delcounter" },
      { signature: "!counters", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.counters", useCaseKey: "commands.useCase.counters" },
      { signature: "#name / #name + N / #name - N", accessKey: "commands.access.allExceptionListed", cooldown: "10s", descriptionKey: "commands.desc.counterUpdate", useCaseKey: "commands.useCase.counterUpdate" },
      { signature: "!addexception username", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addexception", useCaseKey: "commands.useCase.addexception" },
      { signature: "!remexception username", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.remexception", useCaseKey: "commands.useCase.remexception" },
    ],
  },
  {
    categoryKey: "commands.category.chatStats",
    commands: [
      { signature: "!topchatters [day|week|month|all]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.topchatters", useCaseKey: "commands.useCase.topchatters" },
      { signature: "!topsmiles [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.topsmiles", useCaseKey: "commands.useCase.topsmiles" },
      { signature: "!countword <word>", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countword", useCaseKey: "commands.useCase.countword" },
      { signature: "!countmsg [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countmsg", useCaseKey: "commands.useCase.countmsg" },
      { signature: "!countunique [period]", accessKey: "commands.access.all", cooldown: "15s", descriptionKey: "commands.desc.countunique", useCaseKey: "commands.useCase.countunique" },
      { signature: "!botinfo", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.botinfo", useCaseKey: "commands.useCase.botinfo" },
    ],
  },
  {
    categoryKey: "commands.category.moderation",
    commands: [
      { signature: "!addword <word>", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.addword", useCaseKey: "commands.useCase.addword" },
      { signature: "!remword <word>", accessKey: "commands.access.mod", cooldown: null, descriptionKey: "commands.desc.remword", useCaseKey: "commands.useCase.remword" },
      { signature: "!update7tv", accessKey: "commands.access.mod", cooldown: "30s", descriptionKey: "commands.desc.update7tv", useCaseKey: "commands.useCase.update7tv" },
    ],
  },
  {
    categoryKey: "commands.category.miniGames",
    commands: [
      { signature: "!muteduel [@user] [seconds]", accessKey: "commands.access.all", cooldown: "50s", descriptionKey: "commands.desc.muteduel", useCaseKey: "commands.useCase.muteduel" },
      { signature: "!muteaccept", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.muteaccept", useCaseKey: "commands.useCase.muteaccept" },
      { signature: "!совет", accessKey: "commands.access.all", cooldown: null, descriptionKey: "commands.desc.sovet", useCaseKey: "commands.useCase.sovet" },
    ],
  },
];
