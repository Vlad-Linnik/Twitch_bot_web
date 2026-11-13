// /<channel>/variables - dashboard for creating, viewing, editing and deleting the channel's
// # variables (the ones a mod would otherwise manage with !addvar / !delvar in chat).
// Modeled 1:1 on routes/customCommands.js, the other shared-write management page.
//
// Fully gated at tier <= 2: these are WRITES to bot behaviour, not statistics. Every mutation is
// POST + CSRF + rate-limited, matching routes/customCommands.js. Explicit-button actions, not
// autosave, so they stay on settingsWriteLimiter.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const variablesRepo = require("../db/variablesRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSectionEditAccess, exposeSectionEditAccess } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const { parseVariable, normalizeName, MAX_VALUE } = require("../lib/variableValidation");
const { movedPermanently } = require("../lib/movedPermanently");

const router = express.Router();

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// The page lived at /<channel>/counters before variables were called variables. Bookmarks and
// old links keep working; see lib/movedPermanently.js for why a POST gets 308 rather than 301.
router.all("/:channel/counters", movedPermanently((req) => `/${encodeURIComponent(req.params.channel)}/variables`));

router.get("/:channel/variables", requireLevel(2), exposeSectionEditAccess("commands"), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const variables = (await variablesRepo.list(channel.channelLogin)).map((v) => ({
      name: v.name,
      value: v.value,
      access: v.access === "mods" ? "mods" : "all",
    }));

    res.render("variables", {
      channel,
      variables,
      maxValue: MAX_VALUE,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/variables",
  settingsWriteLimiter,
  requireSectionEditAccess("commands"),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/variables`;

      if (req.body.action === "delete") {
        const name = normalizeName(req.body.name);
        if (!name) return res.redirect(`${back}?error=name_required`);
        const before = await variablesRepo.findOne(channel.channelLogin, name);
        await variablesRepo.remove(channel.channelLogin, name);
        if (before) {
          await settingsChangeLogRepo.logChange({
            channelLogin: channel.channelLogin, user: req.user, category: "variable",
            action: "delete", target: name, before, after: null,
          });
        }
        return res.redirect(`${back}?saved=deleted`);
      }

      // Same rules the bot enforces in chat - see lib/variableValidation.js for why that matters.
      const parsed = parseVariable({
        name: req.body.name,
        value: req.body.value,
        access: req.body.access,
      });
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

      const before = await variablesRepo.findOne(channel.channelLogin, parsed.variable.name);
      const after = await variablesRepo.save(channel.channelLogin, parsed.variable);
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin, user: req.user, category: "variable",
        action: before ? "update" : "add", target: parsed.variable.name, before, after,
      });
      // The running bot re-reads variables every 10s (CustomCommands.REFRESH_INTERVAL_MS ->
      // Variables.refreshFromDatabase), so this is live in chat within seconds - no restart needed.
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
