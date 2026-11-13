// "Does this channel have this section, and may this visitor see it?" - the check every route of
// a channel section starts with (news now; movies and games next). Before this it was copied into
// each handler of routes/news.js.
//
// Unknown channel, or a section switched off for the channel (`Channels.<flag>`, see
// lib/channelNav.js's CHANNEL_SECTIONS), reads as "not found" - except for a tier-0 admin, who
// previews a section before switching it on. `allowPreview: false` closes even that, for writes
// that would otherwise leave data behind on a section nobody else can see yet (posting a comment,
// a heart).
//
// On success: req.channel, req.permission (0 admin, 1 owner, 2 moderator, 3 everyone else - see
// middleware/permissions.js) and res.locals.sectionPreview (true while an admin is previewing).
// `maxLevel` additionally gates the route by tier, answering like requireLevel does.
const channelsRepo = require("../db/channelsRepo");
const { computePermission } = require("./permissions");
const { CHANNEL_SECTIONS } = require("../lib/channelNav");

function loadChannelSection(sectionKey, { allowPreview = true, json = false, maxLevel = 3 } = {}) {
  const section = CHANNEL_SECTIONS.find((s) => s.key === sectionKey);
  if (!section) throw new Error(`loadChannelSection: unknown section ${sectionKey}`);

  const notFound = (res) =>
    json ? res.status(404).json({ ok: false, error: "not_found" }) : res.status(404).render("errors/404");

  return async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return notFound(res);

      const userId = req.user?.userId ?? null;
      const permission = await computePermission(userId, channel.channelLogin);
      const enabled = section.flag === null || Boolean(channel[section.flag]);
      if (!enabled && !(allowPreview && permission === 0)) return notFound(res);

      if (permission > maxLevel) {
        if (json) return res.status(userId ? 403 : 401).json({ ok: false, error: "forbidden" });
        return res.status(userId ? 403 : 401).render("errors/403", { requiredLevel: maxLevel });
      }

      req.channel = channel;
      req.permission = permission;
      res.locals.sectionPreview = !enabled;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { loadChannelSection };
