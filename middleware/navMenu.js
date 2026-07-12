// Populates res.locals.navMenu (Creator Dashboard / Channels I Can Moderate
// dropdown) and res.locals.userDisplayColor (own name's chat color in the nav,
// Twitch-resolved or a custom override) for every logged-in request. Computed
// fresh per request, same "no caching, fails closed" convention as
// middleware/permissions.js - a demoted mod or a newly-seeded channel shows up
// correctly on the very next request.
const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const userPreferencesRepo = require("../db/userPreferencesRepo");
const profileCacheRepo = require("../db/profileCacheRepo");

async function navMenuMiddleware(req, res, next) {
  if (!req.user) {
    res.locals.navMenu = null;
    res.locals.userDisplayColor = null;
    return next();
  }

  try {
    const [ownedChannel, moderatedChannelIds, prefs, profile] = await Promise.all([
      channelsRepo.findByOwnerId(req.user.userId),
      modsRepo.getChannelsModeratedBy(req.user.userId),
      userPreferencesRepo.getPreferences(req.user.userId),
      profileCacheRepo.getOrFetchProfile(req.user.userId),
    ]);
    const ownedChannelId = ownedChannel?.channelId;
    const moderatedChannels = (await channelsRepo.findManyByIds(moderatedChannelIds)).filter(
      (channel) => channel.channelId !== ownedChannelId
    );

    res.locals.navMenu = { ownedChannel, moderatedChannels, channelConnected: !!ownedChannel };
    res.locals.userDisplayColor =
      (prefs?.chatColorMode === "custom" && prefs.customChatColor) || profile?.chatColor || null;
  } catch (err) {
    console.error("[navMenu] Failed to compute nav menu, failing closed:", err.message);
    res.locals.navMenu = { ownedChannel: null, moderatedChannels: [], channelConnected: false };
    res.locals.userDisplayColor = null;
  }

  next();
}

module.exports = navMenuMiddleware;
