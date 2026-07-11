const express = require("express");
const games = require("../data/games");

const router = express.Router();

router.get("/games", (req, res) => {
  res.render("games", { games });
});

module.exports = router;
