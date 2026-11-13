const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const adminAllowlist = require("../db/adminAllowlist");
const modPermissionOverridesRepo = require("../db/modPermissionOverridesRepo");
const { SECTION_KEYS, isSectionKey, canEditSection } = require("../lib/moderatorSections");

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

// Whether someone at `level` may CHANGE section `key` of this channel (lib/moderatorSections.js):
// levels 0-1 always, level 2 unless the owner denied that moderator this section, everyone else
// never. The non-rejecting form of requireSectionEditAccess - for deciding which controls a page
// draws, so a button is only shown where the server would accept it. Fails closed.
async function canEditSectionAt(level, channelId, userId, key) {
  if (!isSectionKey(key)) throw new Error(`canEditSectionAt: unknown section ${key}`);
  if (level <= 1) return canEditSection(level, null, key);
  if (level !== 2 || !userId) return false;
  try {
    const override = await modPermissionOverridesRepo.get(channelId, userId);
    return canEditSection(level, override, key);
  } catch (err) {
    console.error("[permissions] canEditSectionAt failed, failing closed:", err);
    return false;
  }
}

// Same tier-2 gate as requireLevel(2) (admin/owner/moderator, same 401/403 rendering), plus the
// per-section check for moderators: the owner can deny an individual moderator the right to change
// one section (db/modPermissionOverridesRepo.js) while still letting them view everything - so this
// middleware is only ever used on mutating routes, never on GETs.
// Honors the same Accept: application/json convention settings.js/csrf.js already use for
// autosave, so a denied moderator's autosave fetch gets a JSON error, not an HTML page.
// On success req.permissionLevel is set, as requireLevel does.
function requireSectionEditAccess(key) {
  if (!isSectionKey(key)) throw new Error(`requireSectionEditAccess: unknown section ${key}`);
  const gate = requireLevel(2);
  return (req, res, next) => {
    gate(req, res, async () => {
      try {
        if (req.permissionLevel <= 1) return next();

        const channel = await channelsRepo.findByLogin(req.params.channel);
        if (!channel) return res.status(404).render("errors/404");

        if (!(await canEditSectionAt(req.permissionLevel, channel.channelId, req.user.userId, key))) {
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

// For a GET page of tier 2: puts into res.locals what this visitor may change, so the view draws
// mutating controls only where the server would accept them -
//   canEditSection    boolean, for this page's own section `key`;
//   editableSections  { <every section key>: boolean }, for a page that also carries a control of
//                     another section (the main settings page's banned-word toggle).
// Runs after requireLevel(2), which has set req.permissionLevel. Fails closed.
function exposeSectionEditAccess(key) {
  if (!isSectionKey(key)) throw new Error(`exposeSectionEditAccess: unknown section ${key}`);
  return async (req, res, next) => {
    try {
      const level = req.permissionLevel;
      let override = null;
      let known = level <= 1;
      if (level === 2 && req.user?.userId) {
        const channel = await channelsRepo.findByLogin(req.params.channel);
        if (channel) {
          try {
            override = await modPermissionOverridesRepo.get(channel.channelId, req.user.userId);
            known = true;
          } catch (err) {
            console.error("[permissions] exposeSectionEditAccess failed, failing closed:", err);
          }
        }
      }
      const editable = Object.fromEntries(
        SECTION_KEYS.map((k) => [k, known && canEditSection(level, override, k)])
      );
      res.locals.editableSections = editable;
      res.locals.canEditSection = editable[key];
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { computePermission, requireLevel, requireSectionEditAccess, canEditSectionAt, exposeSectionEditAccess };
