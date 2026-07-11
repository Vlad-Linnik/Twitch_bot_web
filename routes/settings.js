const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

const MAX_LIST_ITEMS = 200;
const MAX_STRING_LEN = 500;

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_STRING_LEN))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

// The bot fetches this URL server-side to pull 7TV emotes, so reject anything
// that isn't a well-formed http(s) URL rather than persisting it unchecked.
function isValidHttpUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Parses the submitted form into the same shape as config/defaultChannelConfig.json,
// dropping anything that isn't an expected field (never trust the request body shape).
function parseSubmittedConfig(body, existingCommands) {
  const commands = {};
  for (const [name, existing] of Object.entries(existingCommands || {})) {
    commands[name] = {
      ...existing,
      enabled: body[`commands.${name}.enabled`] === "on",
    };
  }

  return {
    bannedWords: {
      words: sanitizeStringList((body.bannedWordsList || "").split("\n")),
      timeoutReason: (body.timeoutReason || "").trim().slice(0, MAX_STRING_LEN),
    },
    spamSignatures: sanitizeStringList((body.spamSignaturesList || "").split("\n")),
    sevenTv: {
      emoteSetUrl: (body.emoteSetUrl || "").trim().slice(0, MAX_STRING_LEN),
    },
    commands,
    responses: {
      busy: sanitizeStringList((body.busyResponses || "").split("\n")),
      yesNo: sanitizeStringList((body.yesNoResponses || "").split("\n")),
      insultModExempt: sanitizeStringList((body.insultModExempt || "").split("\n")),
      insultBotNotMod: (body.insultBotNotMod || "").trim().slice(0, MAX_STRING_LEN),
    },
  };
}

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
    const parsed = parseSubmittedConfig(req.body, existing.commands);

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

module.exports = router;
