const express = require("express");
const oauthClient = require("../twitch/oauthClient");
const { getModerators: getModeratorsFromTwitch } = require("../twitch/channelModerators");
const channelsRepo = require("../db/channelsRepo");
const modsRepo = require("../db/modsRepo");
const ownerTokensRepo = require("../db/ownerTokensRepo");
const { verifyToken } = require("../middleware/csrf");

const router = express.Router();

// Owner-triggered ModsList reconciliation: if the visitor who just logged in owns a
// registered channel, pull Twitch's canonical moderator list for it (their own token is
// the only one that can - see twitch/channelModerators.js) and replace ModsList outright.
// Only ever touches the owner's own channel - never other channels they might moderate.
// Also persists their refresh_token (db/ownerTokensRepo.js) so
// twitch/moderatorSyncScheduler.js can keep repeating this on a schedule without requiring
// them to be logged in every time - saved before the Get Moderators call so a transient
// Twitch failure here still leaves the scheduler able to pick it up later.
async function syncChannelModerators(accessToken, refreshToken, user) {
  const ownedChannel = await channelsRepo.findByOwnerId(user.userId);
  if (!ownedChannel) return;

  await ownerTokensRepo.saveRefreshToken(ownedChannel.channelId, user.userId, refreshToken);

  const moderators = await getModeratorsFromTwitch(accessToken, ownedChannel.channelId);
  await modsRepo.setModerators(ownedChannel.channelId, moderators.map((m) => m.userId));
}

router.get("/login", (req, res) => {
  const state = oauthClient.generateState();
  req.session.oauthState = state;
  res.redirect(oauthClient.buildAuthorizeUrl(state));
});

router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect("/?login_error=1");
  }

  if (!state || state !== req.session.oauthState) {
    return res.status(400).render("errors/403", { requiredLevel: null, message: "Login request expired or invalid. Please try again." });
  }
  delete req.session.oauthState;

  try {
    const tokenData = await oauthClient.exchangeCodeForToken(code);
    const user = await oauthClient.getAuthenticatedUser(tokenData.access_token);

    try {
      await syncChannelModerators(tokenData.access_token, tokenData.refresh_token, user);
    } catch (err) {
      // Non-fatal: login must not fail because the moderator sync did.
      console.error("[auth] Failed to sync channel moderators:", err.response?.data || err.message);
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error("[auth] session regenerate failed:", err);
        return res.redirect("/?login_error=1");
      }
      req.session.user = user;
      res.redirect("/");
    });
  } catch (err) {
    console.error("[auth] OAuth callback failed:", err.response?.data || err.message);
    res.redirect("/?login_error=1");
  }
});

router.post("/logout", verifyToken, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

module.exports = router;