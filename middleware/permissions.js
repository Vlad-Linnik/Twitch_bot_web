const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const adminAllowlist = require("../db/adminAllowlist");
const modPermissionOverridesRepo = require("../db/modPermissionOverridesRepo");

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

// Same tier-2 gate as requireLevel(2) (admin/owner/moderator, same 401/403 rendering), plus one
// extra check for moderators specifically: the owner can deny an individual moderator the right
// to EDIT settings/commands/counters (db/modPermissionOverridesRepo.js) while still letting them
// view everything - so this middleware is only ever used on mutating routes, never on GETs.
// Honors the same Accept: application/json convention settings.js/csrf.js already use for
// autosave, so a denied moderator's autosave fetch gets a JSON error, not an HTML page.
function requireSettingsEditAccess() {
  const gate = requireLevel(2);
  return (req, res, next) => {
    gate(req, res, async () => {
      try {
        if (req.permissionLevel <= 1) return next();

        const channel = await channelsRepo.findByLogin(req.params.channel);
        if (!channel) return res.status(404).render("errors/404");

        const override = await modPermissionOverridesRepo.get(channel.channelId, req.user.userId);
        if (override?.canEditSettings === false) {
          if ((req.get("accept") || "").includes("application/json")) {
            return res.status(403).json({ ok: false, error: "forbidden" });
          }
          return res.status(403).render("errors/403", { requiredLevel: 1 });
        }
        next();
      } catch (err) {
        next(err);
      }
    });
  };
}

module.exports = { computePermission, requireLevel, requireSettingsEditAccess };
