const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { MAX_LIST_ITEMS, sanitizeWord, isValidHttpUrl, parseSubmittedConfig } = require("../lib/settingsValidation");

const router = express.Router();

router.get("/:channel/settings", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    res.render("settings", { channel, config, saved: req.query.saved === "1" });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings", settingsWriteLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const existing = await channelConfigRepo.getConfig(req.params.channel);
    const parsed = parseSubmittedConfig(req.body, existing);

    if (!isValidHttpUrl(parsed.sevenTv.emoteSetUrl)) {
      return res.status(400).render("settings", {
        channel,
        config: { ...existing, ...parsed },
        saved: false,
        error: "7TV emote set URL must be a valid http(s) URL.",
      });
    }

    await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);

    res.redirect(`/${req.params.channel}/settings?saved=1`);
  } catch (err) {
    next(err);
  }
});

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

router.post("/:channel/settings/banned-words/timeout-reason", settingsWriteLimiter, requireLevel(2), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    config.bannedWords.timeoutReason = sanitizeWord(req.body.timeoutReason);
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);

    res.redirect(`/${req.params.channel}/settings/banned-words`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
