// /<channel>/settings/custom-commands/commands - dashboard for creating, viewing and editing the
// channel's custom chat commands (the ones a mod would otherwise manage with !addcommand /
// !settimer / !setpin). Nested under the custom-commands settings sub-page (routes/settings.js's
// /:channel/settings/custom-commands) rather than a bare /:channel/commands, so the two pages
// read as parent/child instead of an unrelated jump.
//
// Fully gated at tier <= 2: these are WRITES to bot behaviour, not statistics. Every mutation is
// POST + CSRF + rate-limited, matching routes/settings.js - the other place this app writes
// config the bot acts on.
//
// This route must be mounted BEFORE routes/channelRedirect.js, whose bare "/:channel" would
// otherwise not conflict (this is 4 segments) - but keep it above anyway so the ordering intent
// stays obvious.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSettingsEditAccess } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const {
  parseCommand,
  normalizeName,
  MIN_TIMER_SECONDS,
  MAX_RESULT_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_CATEGORY_OVERRIDES,
  ANNOUNCEMENT_COLORS,
} = require("../lib/commandValidation");

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

router.get("/:channel/settings/custom-commands/commands", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const commands = (await customCommandsRepo.list(channel.channelLogin)).map((c) => ({
      command: c.command,
      result: c.result,
      timerSeconds: toSeconds(c.timer),
      pin: !!c.pin,
      announce: !!c.announce,
      announceColor: c.announceColor || "primary",
      enabled: c.enabled !== false,
      categoryTexts: c.categoryTexts || [],
      modOnly: !!c.modOnly,
    }));

    res.render("customCommands", {
      channel,
      commands,
      minTimerSeconds: MIN_TIMER_SECONDS,
      maxResultLength: MAX_RESULT_LENGTH,
      maxCategoryLength: MAX_CATEGORY_LENGTH,
      maxCategoryOverrides: MAX_CATEGORY_OVERRIDES,
      announcementColors: ANNOUNCEMENT_COLORS,
      error: req.query.error || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/settings/custom-commands/commands",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/settings/custom-commands/commands`;

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

      // The list's per-row toggle (there is no "enabled" checkbox on the create/edit form
      // anymore - see views/customCommands.ejs) flips enabled on an already-saved command
      // without touching any of its other fields.
      if (req.body.action === "toggle") {
        const name = normalizeName(req.body.name);
        if (!name) return res.redirect(`${back}?error=name_required`);
        const before = await customCommandsRepo.findOne(channel.channelLogin, name);
        if (!before) return res.redirect(`${back}?error=name_required`);
        const after = await customCommandsRepo.save(channel.channelLogin, { ...before, enabled: before.enabled === false });
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
          action: "update", target: name, before, after,
        });
        return res.redirect(`${back}?saved=1`);
      }

      // A variable number of category-override rows (see views/customCommands.ejs, rendered
      // progressively client-side) - urlencoded bodies collapse a single repeated field name to
      // a bare string instead of a one-element array, so normalize both categoryName/
      // categoryResult to arrays before zipping them.
      const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
      const categoryNames = toArray(req.body.categoryName);
      const categoryResults = toArray(req.body.categoryResult);
      const categoryTexts = categoryNames.map((category, i) => ({ category, result: categoryResults[i] }));

      // The create/edit form has no "enabled" checkbox (that's the list's per-row toggle now), so
      // saving text/timer/pin/etc changes must not silently flip a command's enabled state - carry
      // it over from the existing row, defaulting to enabled for a brand-new command.
      const name = normalizeName(req.body.name);
      const before = name ? await customCommandsRepo.findOne(channel.channelLogin, name) : null;

      // Same rules the bot enforces in chat - see lib/commandValidation.js for why that matters.
      const parsed = parseCommand({
        name: req.body.name,
        result: req.body.result,
        timerSeconds: req.body.timerSeconds,
        pin: req.body.pin,
        announce: req.body.announce,
        announceColor: req.body.announceColor,
        enabled: before ? before.enabled !== false : true,
        categoryTexts,
        modOnly: req.body.modOnly,
      });
      if (!parsed.ok) return res.redirect(`${back}?error=${parsed.error}`);

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
