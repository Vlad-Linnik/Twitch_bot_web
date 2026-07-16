// Populates res.locals.navMenu (Creator Dashboard / Channels I Can Moderate
// dropdown) and res.locals.userDisplayColor (own name's chat color in the nav,
// Twitch-resolved or a custom override) for every logged-in request. Computed
// fresh per request, same "no caching, fails closed" convention as
// middleware/permissions.js - a demoted mod or a newly-seeded channel shows up
// correctly on the very next request.
const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const adminAllowlist = require("../db/adminAllowlist");
const botRequestsRepo = require("../db/botRequestsRepo");
// One owner for "how is this user displayed" - the colour policy used to be spelled out here AND
// in routes/about.js, and skipped entirely in routes/userDashboard.js. See db/userProfileService.js.
const userProfileService = require("../db/userProfileService");

async function navMenuMiddleware(req, res, next) {
  if (!req.user) {
    res.locals.navMenu = null;
    res.locals.userDisplayColor = null;
    res.locals.userAvatarUrl = null;
    res.locals.isAdmin = false;
    res.locals.pendingRequestCount = 0;
    return next();
  }

  // Env-allowlist lookup, synchronous and free. The pending-request COUNT (the badge on the
  // nav's Admin tab) is an extra query, so it only ever runs for admins.
  const isAdmin = adminAllowlist.isAdmin(req.user.userId);
  res.locals.isAdmin = isAdmin;
  res.locals.pendingRequestCount = 0;

  try {
    const [ownedChannel, moderatedChannelIds, display, pendingRequestCount] = await Promise.all([
      channelsRepo.findByOwnerId(req.user.userId),
      modsRepo.getChannelsModeratedBy(req.user.userId),
      userProfileService.getDisplayProfile(req.user.userId),
      isAdmin ? botRequestsRepo.countPending() : 0,
    ]);
    res.locals.pendingRequestCount = pendingRequestCount;
    const ownedChannelId = ownedChannel?.channelId;
    const moderatedChannels = (await channelsRepo.findManyByIds(moderatedChannelIds)).filter(
      (channel) => channel.channelId !== ownedChannelId
    );

    res.locals.navMenu = { ownedChannel, moderatedChannels, channelConnected: !!ownedChannel };
    res.locals.userDisplayColor = display.color;
    // Prefer the cached profile's avatar (refreshed every 7 days) over the copy frozen into the
    // session at login - a user who changes their Twitch avatar shouldn't have to log out and back
    // in to see it. The session value is the fallback so a cache miss still renders something.
    res.locals.userAvatarUrl = display.avatarUrl || req.user.avatarUrl || null;
  } catch (err) {
    console.error("[navMenu] Failed to compute nav menu, failing closed:", err.message);
    res.locals.navMenu = { ownedChannel: null, moderatedChannels: [], channelConnected: false };
    res.locals.userDisplayColor = null;
    res.locals.userAvatarUrl = req.user.avatarUrl || null;
  }

  next();
}

module.exports = navMenuMiddleware;
