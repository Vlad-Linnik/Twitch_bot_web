// /<channel>/commands - dashboard for creating, viewing and editing the channel's custom chat
// commands (the ones a mod would otherwise manage with !addcommand / !settimer / !setpin).
//
// Fully gated at tier <= 2: these are WRITES to bot behaviour, not statistics. Every mutation is
// POST + CSRF + rate-limited, matching routes/settings.js - the other place this app writes
// config the bot acts on.
//
// This route must be mounted BEFORE routes/channelRedirect.js, whose bare "/:channel" would
// otherwise not conflict (this is 2 segments) - but keep it above anyway so the ordering intent
// stays obvious.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSettingsEditAccess } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const { parseCommand, normalizeName, MIN_TIMER_SECONDS, MAX_RESULT_LENGTH } = require("../lib/commandValidation");

const router = express.Router();

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// The bot stores timers in milliseconds; the form speaks seconds. Convert at the boundary rather
// than leaking the unit mismatch into the view.
const toSeconds = (timerMs) => (timerMs ? Math.round(timerMs / 1000) : null);

router.get("/:channel/commands", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const commands = (await customCommandsRepo.list(channel.channelLogin)).map((c) => ({
      command: c.command,
      result: c.result,
      timerSeconds: toSeconds(c.timer),
      pin: !!c.pin,
    }));

    res.render("customCommands", {
      channel,
      commands,
      minTimerSeconds: MIN_TIMER_SECONDS,
      maxResultLength: MAX_RESULT_LENGTH,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/commands",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/commands`;

      if (req.body.action === "delete") {
        const name = normalizeName(req.body.name);
        if (!name) return res.redirect(`${back}?error=name_required`);
        const before = await customCommandsRepo.findOne(channel.channelLogin, name);
        await customCommandsRepo.remove(channel.channelLogin, name);
        if (before) {
          await settingsChangeLogRepo.logChange({
            channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
            action: "delete", target: name, before, after: null,
          });
        }
        return res.redirect(`${back}?saved=deleted`);
      }

      // Same rules the bot enforces in chat - see lib/commandValidation.js for why that matters.
      const parsed = parseCommand({
        name: req.body.name,
        result: req.body.result,
        timerSeconds: req.body.timerSeconds,
        pin: req.body.pin,
      });
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

      const before = await customCommandsRepo.findOne(channel.channelLogin, parsed.command.command);
      const after = await customCommandsRepo.save(channel.channelLogin, parsed.command);
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
        action: before ? "update" : "add", target: parsed.command.command, before, after,
      });
      // The running bot re-reads custom_commands every 10s (CustomCommands.REFRESH_INTERVAL_MS),
      // so this is live in chat within seconds - no restart, no extra signal to send.
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
