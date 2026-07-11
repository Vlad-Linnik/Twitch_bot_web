const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const adminAllowlist = require("../db/adminAllowlist");

// Permission levels: 0 = app developer, 1 = channel owner, 2 = channel
// moderator, 3 = regular user (default / logged out). Lower number = more
// privileged. Computed fresh per request (cheap indexed lookups) so a
// demoted mod loses access on their very next request, not after a session TTL.
// Fails closed: any error or unknown channel resolves to the least-privileged tier.
async function computePermission(userId, channelLogin) {
  try {
    if (userId && adminAllowlist.isAdmin(userId)) return 0;
    if (!channelLogin) return userId ? 3 : 3;

    const channel = await channelsRepo.findByLogin(channelLogin);
    if (!channel) return 3;

    if (userId && channel.ownerId === String(userId)) return 1;

    if (userId) {
      const isMod = await modsRepo.isModerator(channel.channelId, userId);
      if (isMod) return 2;
    }

    return 3;
  } catch (err) {
    console.error("[permissions] computePermission failed, failing closed:", err);
    return 3;
  }
}

function requireLevel(maxLevel) {
  return async (req, res, next) => {
    const channelLogin = req.params.channel;
    const userId = req.user?.userId ?? null;
    const level = await computePermission(userId, channelLogin);
    req.permissionLevel = level;
    if (level > maxLevel) {
      return res.status(userId ? 403 : 401).render("errors/403", { requiredLevel: maxLevel });
    }
    next();
  };
}

module.exports = { computePermission, requireLevel };
