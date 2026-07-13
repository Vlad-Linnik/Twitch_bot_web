// /<channel>/counters - dashboard for creating, viewing, editing and deleting the channel's
// # counters (the ones a mod would otherwise manage with !addcounter / !delcounter in chat).
// Modeled 1:1 on routes/customCommands.js, the other shared-write management page.
//
// Fully gated at tier <= 2: these are WRITES to bot behaviour, not statistics. Every mutation is
// POST + CSRF + rate-limited, matching routes/customCommands.js. Explicit-button actions, not
// autosave, so they stay on settingsWriteLimiter.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const countersRepo = require("../db/countersRepo");
const { requireLevel } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const { parseCounter, normalizeName, MAX_COUNT } = require("../lib/counterValidation");

const router = express.Router();

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

router.get("/:channel/counters", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const counters = (await countersRepo.list(channel.channelLogin)).map((c) => ({
      name: c.counter_name,
      count: c.count,
      access: c.access === "mods" ? "mods" : "all",
    }));

    res.render("counters", {
      channel,
      counters,
      maxCount: MAX_COUNT,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/counters",
  settingsWriteLimiter,
  requireLevel(2),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/counters`;

      if (req.body.action === "delete") {
        const name = normalizeName(req.body.name);
        if (!name) return res.redirect(`${back}?error=name_required`);
        await countersRepo.remove(channel.channelLogin, name);
        return res.redirect(`${back}?saved=deleted`);
      }

      // Same rules the bot enforces in chat - see lib/counterValidation.js for why that matters.
      const parsed = parseCounter({
        name: req.body.name,
        count: req.body.count,
        access: req.body.access,
      });
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

      await countersRepo.save(channel.channelLogin, parsed.counter);
      // The running bot re-reads counters every 10s (CustomCommands.REFRESH_INTERVAL_MS ->
      // Counter.refreshFromDatabase), so this is live in chat within seconds - no restart needed.
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
