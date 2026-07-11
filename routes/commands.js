const express = require("express");
const commandGroups = require("../data/commands");

const router = express.Router();

router.get("/commands", (req, res) => {
  res.render("commands", { commandGroups });
});

module.exports = router;
