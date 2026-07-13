const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const countersRepo = require("../db/countersRepo");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter, autosaveLimiter } = require("../middleware/rateLimiters");
const { MAX_LIST_ITEMS, sanitizeWord, isValidHttpUrl, parseSubmittedConfig } = require("../lib/settingsValidation");

const router = express.Router();

// Settings-type forms are saved two ways: public/js/autosave.js fetches with
// `Accept: application/json` and needs a JSON status back, while the no-JS
// fallback is the classic POST -> redirect. Same handler, two response shapes.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

function respondSaved(req, res, redirectTo) {
  if (wantsJson(req)) return res.status(200).json({ ok: true });
  res.redirect(redirectTo);
}

router.get("/:channel/settings", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const [config, customCommands, counters] = await Promise.all([
      channelConfigRepo.getConfig(req.params.channel),
      customCommandsRepo.list(req.params.channel),
      countersRepo.list(req.params.channel),
    ]);
    res.render("settings", {
      channel,
      config,
      customCommandCount: customCommands.length,
      counterCount: counters.length,
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings", autosaveLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const existing = await channelConfigRepo.getConfig(req.params.channel);
    const parsed = parseSubmittedConfig(req.body, existing);

    if (!isValidHttpUrl(parsed.sevenTv.emoteSetUrl)) {
      const message = "7TV emote set URL must be a valid http(s) URL.";
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: message });
      const [customCommands, counters] = await Promise.all([
        customCommandsRepo.list(req.params.channel),
        countersRepo.list(req.params.channel),
      ]);
      return res.status(400).render("settings", {
        channel,
        config: { ...existing, ...parsed },
        customCommandCount: customCommands.length,
        counterCount: counters.length,
        saved: false,
        error: message,
      });
    }

    await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);

    respondSaved(req, res, `/${req.params.channel}/settings?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Command-group settings moved off the main settings page onto their own sub-pages
// (custom commands, counters) - each renders a subset of the command rows and POSTs
// back through the same parseSubmittedConfig, which carries every unrendered field
// over from the stored config (see lib/settingsValidation.js's partial-form contract).
function registerConfigSubPage(basePath, viewName, getExtras = null) {
  router.get(`/:channel${basePath}`, requireLevel(2), async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const extras = getExtras ? await getExtras(req.params.channel) : {};
      res.render(viewName, { channel, config, saved: req.query.saved === "1", ...extras });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}`, autosaveLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const existing = await channelConfigRepo.getConfig(req.params.channel);
      const parsed = parseSubmittedConfig(req.body, existing);
      await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);

      respondSaved(req, res, `/${req.params.channel}${basePath}?saved=1`);
    } catch (err) {
      next(err);
    }
  });
}

registerConfigSubPage("/settings/custom-commands", "channelCustomCommandsSettings");
registerConfigSubPage("/settings/counters", "channelCountersSettings");

// Banned Words and Spam Signatures moved off the main settings page onto
// their own sub-pages (search + add/edit/delete instead of one big textarea
// blob) - both are just a flat string array on the config, so the add/edit/
// delete routes share this factory instead of tripling the same CRUD logic.
function registerWordListRoutes(basePath, viewName, getList) {
  router.get(`/:channel${basePath}`, requireLevel(2), async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const rawEdit = parseInt(req.query.edit, 10);
      const editIndex = Number.isInteger(rawEdit) && rawEdit >= 0 && rawEdit < words.length ? rawEdit : null;

      res.render(viewName, { channel, config, editIndex });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/add`, settingsWriteLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const word = sanitizeWord(req.body.word);
      if (word && !words.includes(word) && words.length < MAX_LIST_ITEMS) {
        words.push(word);
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/edit`, settingsWriteLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const index = parseInt(req.body.index, 10);
      const word = sanitizeWord(req.body.word);
      if (word && Number.isInteger(index) && index >= 0 && index < words.length) {
        words[index] = word;
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/delete`, settingsWriteLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const index = parseInt(req.body.index, 10);
      if (Number.isInteger(index) && index >= 0 && index < words.length) {
        words.splice(index, 1);
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });
}

registerWordListRoutes("/settings/banned-words", "channelBannedWords", (config) => config.bannedWords.words);
registerWordListRoutes("/settings/spam-signatures", "channelSpamSignatures", (config) => config.spamSignatures);

router.post("/:channel/settings/banned-words/timeout-reason", autosaveLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    config.bannedWords.timeoutReason = sanitizeWord(req.body.timeoutReason);
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);

    respondSaved(req, res, `/${req.params.channel}/settings/banned-words`);
  } catch (err) {
    next(err);
  }
});

// The banned-word detection feature switch (the bot's commands.insult.enabled flag). It lives
// on the Banned Words page, next to the word list it gates, not in the commands table - it has
// no chat signature and never behaved like a command.
router.post("/:channel/settings/banned-words/detection-toggle", autosaveLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    config.commands.insult = { ...config.commands.insult, enabled: req.body.detectionEnabled === "on" };
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);

    respondSaved(req, res, `/${req.params.channel}/settings/banned-words`);
  } catch (err) {
    next(err);
  }
});

// Ban reason shown to users caught by a spam signature - mirrors banned-words' timeout reason.
router.post("/:channel/settings/spam-signatures/reason", autosaveLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    config.spamBanReason = sanitizeWord(req.body.spamBanReason);
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);

    respondSaved(req, res, `/${req.params.channel}/settings/spam-signatures`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
