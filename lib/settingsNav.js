// The channel settings catalog: every settings page of a channel, grouped into categories, as the
// left panel (views/partials/settingsShellOpen.ejs) draws it. One list, so the panel, the redirect
// from the bare /:channel/settings and the tests cannot disagree about what exists or what comes
// first.
//
// A category with one page is a link; a category with several is a heading over its pages, open
// unless the visitor folded it.
//
// `section` is the moderator right that covers the page (lib/moderatorSections.js). It never hides a
// page - a moderator may view everything - it only marks the pages they may not change. `minLevel`
// does hide one: the moderators page exists only for the owner and the site admin.

const CATEGORIES = [
  {
    // The fun page holds built-in commands, so unlike its neighbours it stays under the "settings"
    // moderator right: the right follows the config field (configFieldSection), not the category.
    key: "commands",
    icon: "🛠️",
    items: [
      { key: "customCommands", icon: "📜", path: "/settings/custom-commands/commands", labelKey: "settingsNav.customCommandsList", section: "commands" },
      { key: "customCommandsSettings", icon: "⏱️", path: "/settings/custom-commands", labelKey: "settingsNav.customCommandsSettings", section: "commands" },
      { key: "fun", icon: "🎲", path: "/settings/fun", labelKey: "settingsNav.fun", section: "settings" },
    ],
  },
  {
    key: "variables",
    icon: "🔢",
    items: [
      { key: "variables", icon: "🗂️", path: "/variables", labelKey: "settingsNav.variablesList", section: "commands" },
      { key: "variablesSettings", icon: "💬", path: "/settings/variables", labelKey: "settingsNav.variablesSettings", section: "commands" },
    ],
  },
  {
    key: "chatModeration",
    icon: "🚫",
    items: [
      { key: "bannedWords", icon: "🤬", path: "/settings/banned-words", labelKey: "channelSettings.bannedWordsHeading", section: "chatModeration" },
      { key: "spamSignatures", icon: "🛡️", path: "/settings/spam-signatures", labelKey: "channelSettings.spamSignaturesHeading", section: "chatModeration" },
      { key: "longBans", icon: "⏳", path: "/settings/long-bans", labelKey: "channelSettings.group.longBans", section: "chatModeration" },
    ],
  },
  {
    key: "unbanBureau",
    icon: "🛂",
    items: [{ key: "unbanBureau", icon: "🛂", path: "/settings/unban-bureau", labelKey: "unbanBureau.title", section: "bureau" }],
  },
  {
    // The OBS widgets. The weather widget's page holds the city - the streamer's whereabouts - so
    // it is the owner's alone (routes/widgets.js). Of donation media the queue panel and the
    // placeholder pictures are every moderator's; the setup page holds the platforms' keys and is the owner's, and so is the
    // panel's button theme (routes/donationMedia.js).
    key: "widgets",
    icon: "🧩",
    items: [
      { key: "weatherWidget", icon: "⛅", path: "/settings/widgets/weather", labelKey: "settingsNav.weatherWidget", section: null, minLevel: 1 },
      { key: "donationMediaQueue", icon: "🎬", path: "/settings/donation-media/queue", labelKey: "settingsNav.donationMediaQueue", section: "donationMedia" },
      { key: "donationMediaPlaceholders", icon: "🖼️", path: "/settings/donation-media/placeholders", labelKey: "settingsNav.donationMediaPlaceholders", section: "donationMedia" },
      { key: "donationMediaSetup", icon: "🔌", path: "/settings/donation-media", labelKey: "settingsNav.donationMediaSetup", section: null, minLevel: 1 },
      { key: "donationMediaButtons", icon: "🎛️", path: "/settings/donation-media/buttons", labelKey: "settingsNav.donationMediaButtons", section: null, minLevel: 1 },
    ],
  },
  {
    key: "chatStats",
    icon: "📊",
    items: [{ key: "chatStats", icon: "📊", path: "/settings/stats", labelKey: "settingsNav.chatStats", section: "settings" }],
  },
  {
    key: "bot",
    icon: "🤖",
    items: [{ key: "bot", icon: "🤖", path: "/settings/bot", labelKey: "settingsNav.bot", section: "settings" }],
  },
  {
    key: "management",
    icon: "⚙️",
    items: [
      { key: "moderators", icon: "👮", path: "/settings/moderators", labelKey: "channelSettings.moderatorsHeading", section: null, minLevel: 1 },
      { key: "changeLog", icon: "📖", path: "/settings/change-log", labelKey: "channelSettings.changeLogHeading", section: null },
    ],
  },
].map((c) => ({ ...c, labelKey: `settingsNav.category.${c.key}` }));

// The page the bare /:channel/settings opens: the first page of the first category.
function firstPagePath(channelLogin) {
  return `/${channelLogin}${CATEGORIES[0].items[0].path}`;
}

// The panel for one visitor and one page:
//   [{ key, icon, labelKey, active, collapsed, items: [{ key, icon, href, labelKey, active, readOnly }] }]
// `level`: middleware/permissions.js's 0-3; `editableSections`: { section: bool } as
// exposeSectionEditAccess fills it (missing = treated as editable, the server is the guarantee);
// `collapsed`: the category keys the visitor folded (parseCollapsed).
function buildSettingsNav({ channelLogin, level, editableSections = {}, activeKey, collapsed = new Set() }) {
  const base = `/${channelLogin}`;
  return CATEGORIES.map((category) => {
    const items = category.items
      .filter((item) => item.minLevel === undefined || (Number.isInteger(level) && level <= item.minLevel))
      .map((item) => ({
        key: item.key,
        icon: item.icon,
        href: base + item.path,
        labelKey: item.labelKey,
        active: item.key === activeKey,
        readOnly: item.section !== null && editableSections[item.section] === false,
      }));
    // A category left with one page for this visitor (management, for a moderator) is drawn as a
    // single link, and then it is named after the page it leads to, not after the category.
    const named = items.length === 1 && category.items.length > 1 ? items[0] : category;
    return {
      key: category.key,
      icon: named.icon,
      labelKey: named.labelKey,
      active: items.some((i) => i.active),
      collapsed: collapsed.has(category.key),
      items,
    };
  }).filter((category) => category.items.length > 0);
}

// The three settings pages made of the bot's built-in command rows, by URL segment. Which page a
// command sits on is presentation only: they all save through POST /:channel/settings, and the
// moderator right that covers them is lib/moderatorSections.js's configFieldSection, not this.
const COMMAND_PAGES = {
  stats: { navKey: "chatStats", commands: ["topchatters", "topsmiles", "countword", "countmsg", "countunique", "update7tv"] },
  fun: { navKey: "fun", commands: ["randomclip", "weather", "track", "clip", "sr", "muteduel"] },
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

// Which categories the visitor folded: their keys joined by dots, in a cookie for the same reason as
// the pin. It is one list for all channels. Keys that are no longer categories are dropped.
const COLLAPSED_COOKIE = "settingsNavCollapsed";

function parseCollapsed(cookieValue) {
  const known = new Set(CATEGORIES.map((c) => c.key));
  return new Set(String(cookieValue || "").split(".").filter((key) => known.has(key)));
}

module.exports = {
  CATEGORIES,
  PAGE_KEYS,
  PIN_COOKIE,
  COLLAPSED_COOKIE,
  COMMAND_PAGES,
  PLACED_ELSEWHERE,
  firstPagePath,
  buildSettingsNav,
  isPageKey,
  isPinned,
  parseCollapsed,
  unplacedCommands,
};
