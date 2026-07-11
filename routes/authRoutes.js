const express = require("express");
const oauthClient = require("../twitch/oauthClient");
const { verifyToken } = require("../middleware/csrf");

const router = express.Router();

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