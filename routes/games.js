const express = require("express");

const router = express.Router();

// On-site games are future work - the mini-game commands that used to be
// listed here (!muteduel, !совет) now live under the Commands page's
// "Mini-games" category (data/commands.js), since they're chat commands, not
// on-site games. See d:\TwitchBotProject\план.txt.
router.get("/games", (req, res) => {
  res.render("games");
});

module.exports = router;
