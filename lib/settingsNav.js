// The channel settings catalog: every settings page of a channel, grouped into categories, as the
// left panel (views/partials/settingsShellOpen.ejs) draws it. One list, so the panel, the redirect
// from the bare /:channel/settings and the tests cannot disagree about what exists or what comes
// first.
//
// A category with one page is a link; a category with several is a heading over its pages, all
// visible at once, so any page is one click away from any other.
//
// `section` is the moderator right that covers the page (lib/moderatorSections.js). It never hides a
// page - a moderator may view everything - it only marks the pages they may not change. `minLevel`
// does hide one: the moderators page exists only for the owner and the site admin.

const CATEGORIES = [
  {
    key: "customCommands",
    icon: "🛠️",
    items: [
      { key: "customCommands", path: "/settings/custom-commands/commands", labelKey: "settingsNav.customCommandsList", section: "commands" },
      { key: "customCommandsSettings", path: "/settings/custom-commands", labelKey: "settingsNav.customCommandsSettings", section: "commands" },
    ],
  },
  {
    key: "variables",
    icon: "🔢",
    items: [
      { key: "variables", path: "/variables", labelKey: "settingsNav.variablesList", section: "commands" },
      { key: "variablesSettings", path: "/settings/variables", labelKey: "settingsNav.variablesSettings", section: "commands" },
    ],
  },
  {
    key: "chatModeration",
    icon: "🚫",
    items: [
      { key: "bannedWords", path: "/settings/banned-words", labelKey: "channelSettings.bannedWordsHeading", section: "chatModeration" },
      { key: "spamSignatures", path: "/settings/spam-signatures", labelKey: "channelSettings.spamSignaturesHeading", section: "chatModeration" },
      { key: "longBans", path: "/settings/long-bans", labelKey: "channelSettings.group.longBans", section: "chatModeration" },
    ],
  },
  {
    key: "unbanBureau",
    icon: "🛂",
    items: [{ key: "unbanBureau", path: "/settings/unban-bureau", labelKey: "unbanBureau.title", section: "bureau" }],
  },
  {
    key: "chatStats",
    icon: "📊",
    items: [{ key: "chatStats", path: "/settings/stats", labelKey: "settingsNav.chatStats", section: "settings" }],
  },
  {
    key: "fun",
    icon: "🎲",
    items: [{ key: "fun", path: "/settings/fun", labelKey: "settingsNav.fun", section: "settings" }],
  },
  {
    key: "bot",
    icon: "🤖",
    items: [{ key: "bot", path: "/settings/bot", labelKey: "settingsNav.bot", section: "settings" }],
  },
  {
    key: "management",
    icon: "⚙️",
    items: [
      { key: "moderators", path: "/settings/moderators", labelKey: "channelSettings.moderatorsHeading", section: null, minLevel: 1 },
      { key: "changeLog", path: "/settings/change-log", labelKey: "channelSettings.changeLogHeading", section: null },
    ],
  },
].map((c) => ({ ...c, labelKey: `settingsNav.category.${c.key}` }));

// The page the bare /:channel/settings opens: the first page of the first category.
function firstPagePath(channelLogin) {
  return `/${channelLogin}${CATEGORIES[0].items[0].path}`;
}

// The panel for one visitor and one page:
//   [{ key, icon, labelKey, active, items: [{ key, href, labelKey, active, readOnly }] }]
// `level`: middleware/permissions.js's 0-3; `editableSections`: { section: bool } as
// exposeSectionEditAccess fills it (missing = treated as editable, the server is the guarantee).
function buildSettingsNav({ channelLogin, level, editableSections = {}, activeKey }) {
  const base = `/${channelLogin}`;
  return CATEGORIES.map((category) => {
    const items = category.items
      .filter((item) => item.minLevel === undefined || (Number.isInteger(level) && level <= item.minLevel))
      .map((item) => ({
        key: item.key,
        href: base + item.path,
        labelKey: item.labelKey,
        active: item.key === activeKey,
        readOnly: item.section !== null && editableSections[item.section] === false,
      }));
    // A category left with one page for this visitor (management, for a moderator) is drawn as a
    // single link, and then it is named after the page it leads to, not after the category.
    const labelKey = items.length === 1 && category.items.length > 1 ? items[0].labelKey : category.labelKey;
    return {
      key: category.key,
      icon: category.icon,
      labelKey,
      active: items.some((i) => i.active),
      items,
    };
  }).filter((category) => category.items.length > 0);
}

// The three settings pages made of the bot's built-in command rows, by URL segment. Which page a
// command sits on is presentation only: they all save through POST /:channel/settings, and the
// moderator right that covers them is lib/moderatorSections.js's configFieldSection, not this.
const COMMAND_PAGES = {
  stats: { navKey: "chatStats", commands: ["topchatters", "topsmiles", "countword", "countmsg", "countunique", "update7tv"] },
  fun: { navKey: "fun", commands: ["randomclip", "weather", "muteduel"] },
  bot: { navKey: "bot", commands: ["botinfo"] },
};

// Commands drawn on another page, next to the setting they belong to: the custom-command and
// variable chat commands on their own settings pages, the banned-word switch (insult) on the
// banned words page, long bans on theirs, the two mention behaviours on the bot page as toggles.
const PLACED_ELSEWHERE = new Set([
  "question", "directmsg", "insult", "customCommandTimer", "varUpdate",
  "addcommand", "settimer", "setpin", "setannounce", "delcommand",
  "addvar", "delvar", "vars", "exception",
  "longban", "cancellongban", "longbans",
]);

// A command none of the above claims - one the bot added later - is shown on the bot page under
// "other commands" rather than disappearing from the site.
function unplacedCommands(commandNames) {
  const placed = new Set(Object.values(COMMAND_PAGES).flatMap((p) => p.commands));
  return commandNames.filter((name) => !placed.has(name) && !PLACED_ELSEWHERE.has(name));
}

// Every page key, for the routes to check theirs against.
const PAGE_KEYS = CATEGORIES.flatMap((c) => c.items.map((i) => i.key));

function isPageKey(key) {
  return PAGE_KEYS.includes(key);
}

// The panel can be pinned open on a wide screen; the choice is a cookie so the first paint already
// has it right (a script-applied preference would flash the panel in or out on every page).
const PIN_COOKIE = "settingsNavPinned";

function isPinned(cookieValue) {
  return cookieValue !== "0";
}

module.exports = {
  CATEGORIES,
  PAGE_KEYS,
  PIN_COOKIE,
  COMMAND_PAGES,
  PLACED_ELSEWHERE,
  firstPagePath,
  buildSettingsNav,
  isPageKey,
  isPinned,
  unplacedCommands,
};
