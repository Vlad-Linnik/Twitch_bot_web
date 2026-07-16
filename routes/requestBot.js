// Self-service "add the bot to my channel" request (/request-bot), the counterpart of the
// admin panel's request queue (routes/admin.js). Login-required but no tier gate - it's for
// visitors who do NOT have a channel yet. Approval is what actually registers the channel
// (channelsRepo.upsertChannel, same effect as scripts/seedChannel.js), so the approved
// request doubles as the consent record behind Channels.consentedAt.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const botRequestsRepo = require("../db/botRequestsRepo");
const { parseRequestForm, MESSAGE_MAX_LENGTH } = require("../lib/requestBotValidation");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const env = require("../config/env");

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).render("errors/403", { requiredLevel: null });
  }
  next();
}

router.get("/request-bot", requireLogin, async (req, res, next) => {
  try {
    const [ownedChannel, pending, latest] = await Promise.all([
      channelsRepo.findByOwnerId(req.user.userId),
      botRequestsRepo.findPendingByUser(req.user.userId),
      botRequestsRepo.findLatestByUser(req.user.userId),
    ]);

    res.render("requestBot", {
      ownedChannel,
      pending,
      // Only surface a rejection when it's the user's latest word from the admins - once a
      // newer request is pending, the old rejection is history, not the current state.
      rejected: !pending && latest?.status === "rejected" ? latest : null,
      botLogin: env.botLogin,
      messageMaxLength: MESSAGE_MAX_LENGTH,
      submitted: req.query.submitted === "1",
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/request-bot", settingsWriteLimiter, requireLogin, verifyToken, async (req, res, next) => {
  try {
    // findByOwnerId is enabled-only on purpose: the owner of a DISABLED channel may
    // legitimately re-request the bot, and approval re-enables it via upsertChannel.
    const ownedChannel = await channelsRepo.findByOwnerId(req.user.userId);
    if (ownedChannel) return res.redirect("/request-bot");

    const parsed = parseRequestForm(req.body);
    if (!parsed.ok) {
      return res.redirect(`/request-bot?error=${parsed.error}`);
    }

    try {
      await botRequestsRepo.create(req.user, parsed.message);
    } catch (err) {
      // Concurrent double-submit lost the race to the partial unique index - the request
      // exists, which is exactly what the user wanted; show them its pending state.
      if (!botRequestsRepo.isDuplicatePendingError(err)) throw err;
    }

    res.redirect("/request-bot?submitted=1");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
