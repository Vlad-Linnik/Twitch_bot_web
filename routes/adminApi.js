// Read-only, bearer-token-gated JSON API for the Unban Bureau (Бюро амнистии) data - meant for an
// external tool/assistant to fetch and analyze a dossier, never for the browser session flow the
// rest of this app uses. See middleware/adminApiAuth.js for the auth model. Deliberately exposes
// no decision/vote/sniper endpoints - this can look at the queue, never act on it; mutating routes
// stay on routes/unbanBureau.js's session-gated tier-2 access.
const express = require("express");
const requireApiToken = require("../middleware/adminApiAuth");
const { adminApiLimiter } = require("../middleware/rateLimiters");
const channelsRepo = require("../db/channelsRepo");
const unbanRequestsRepo = require("../db/unbanRequestsRepo");
const unbanDossierRepo = require("../db/unbanDossierRepo");

const router = express.Router();

router.use("/admin/api", adminApiLimiter, requireApiToken);

// GET /admin/api/unban-requests?channel=<login>
router.get("/admin/api/unban-requests", async (req, res, next) => {
  try {
    const login = typeof req.query.channel === "string" ? req.query.channel.trim().toLowerCase() : "";
    if (!login) return res.status(400).json({ error: "channel_required" });

    const channel = await channelsRepo.findByLogin(login);
    if (!channel) return res.status(404).json({ error: "channel_not_found" });

    const requests = await unbanRequestsRepo.listPendingForChannel(channel.channelId);
    res.json({ ok: true, channel: channel.channelLogin, requests });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api/unban-requests/:id/dossier
router.get("/admin/api/unban-requests/:id/dossier", async (req, res, next) => {
  try {
    const unbanCase = await unbanRequestsRepo.findById(req.params.id);
    if (!unbanCase) return res.status(404).json({ error: "not_found" });

    const channel = await channelsRepo.findByChannelId(unbanCase.channelId);
    if (!channel) return res.status(404).json({ error: "channel_not_found" });

    const dossier = await unbanDossierRepo.getDossier(channel.channelLogin, unbanCase, {
      before: req.query.before || null,
    });

    // twitchModLogs stripped for the same reason listPendingForChannel projects it out server-side:
    // it's the largest field on the doc and everything useful in it is already surfaced,
    // unduplicated, inside `dossier` (counts, actions, modComments, log, etc.).
    const { twitchModLogs, ...request } = unbanCase;
    res.json({ ok: true, channel: channel.channelLogin, request, dossier });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
