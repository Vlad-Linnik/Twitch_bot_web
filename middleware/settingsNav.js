// Puts the channel settings panel (lib/settingsNav.js) into res.locals.settingsNav for a settings
// page's GET. Runs after requireLevel and exposeSectionEditAccess, which supply the level and the
// editable sections; the pin and the folded categories come from their cookies.
const cookie = require("cookie");
const { buildSettingsNav, isPageKey, isPinned, parseCollapsed, PIN_COOKIE, COLLAPSED_COOKIE } = require("../lib/settingsNav");

function settingsNav(activeKey) {
  if (!isPageKey(activeKey)) throw new Error(`settingsNav: unknown page ${activeKey}`);
  return (req, res, next) => {
    const cookies = cookie.parse(req.headers.cookie || "");
    res.locals.settingsNav = {
      activeKey,
      pinned: isPinned(cookies[PIN_COOKIE]),
      pinCookie: PIN_COOKIE,
      collapsedCookie: COLLAPSED_COOKIE,
      categories: buildSettingsNav({
        channelLogin: req.params.channel.toLowerCase(),
        level: req.permissionLevel,
        editableSections: res.locals.editableSections,
        activeKey,
        collapsed: parseCollapsed(cookies[COLLAPSED_COOKIE]),
      }),
    };
    next();
  };
}

module.exports = { settingsNav };
