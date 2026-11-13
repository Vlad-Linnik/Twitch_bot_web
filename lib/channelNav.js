// The channel navbar (views/partials/channelHeader.ejs): which sections of a channel a visitor
// sees, in what order, and which one is active.
//
// Statistics is always there - it is the channel's home (routes/channelRedirect.js). Every other
// section is off by default and switched on per channel by a site admin (`Channels.<flag>`); a
// switched-off section is invisible to everyone except a tier-0 admin, who sees it greyed out
// as a preview - the same rule the section's own routes apply (e.g. routes/news.js 404s a
// disabled feed for anyone but an admin).
//
// `live: false` marks a section whose pages do not exist yet. It is never shown, flag or no
// flag: an admin preview link to a route that is not mounted would be a 404 dressed as a menu
// item. The stage that mounts the routes flips it.
const CHANNEL_SECTIONS = [
  { key: "statistics", path: "statistics/chat", flag: null, live: true },
  { key: "news", path: "news", flag: "newsEnabled", live: true },
  { key: "movies", path: "movies", flag: "moviesEnabled", live: true },
  { key: "games", path: "games", flag: "gamesEnabled", live: true },
];

// Returns [{ key, href, active, preview, transition }]. `transition` is "backward" for items to
// the LEFT of the active one, so moving left along the bar slides the page the same way the
// statistics tabs do (views/partials/statsTabs.ejs); null otherwise (the default forward slide).
function buildChannelNav(channel, { permission = 3, active = null } = {}) {
  const isAdmin = permission === 0;
  const visible = [];
  for (const section of CHANNEL_SECTIONS) {
    if (!section.live) continue;
    const enabled = section.flag === null || Boolean(channel[section.flag]);
    if (!enabled && !isAdmin) continue;
    visible.push({ section, preview: !enabled });
  }

  const activeIndex = visible.findIndex((v) => v.section.key === active);
  return visible.map(({ section, preview }, index) => ({
    key: section.key,
    href: `/${channel.channelLogin}/${section.path}`,
    active: index === activeIndex,
    preview,
    transition: activeIndex !== -1 && index < activeIndex ? "backward" : null,
  }));
}

module.exports = { CHANNEL_SECTIONS, buildChannelNav };
