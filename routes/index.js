const express = require("express");
const { authLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.use("/auth", authLimiter, require("./authRoutes"));
router.use("/", require("./home"));
router.use("/", require("./accountSettings"));
router.use("/", require("./notifications"));
router.use("/", require("./settings"));
router.use("/", require("./statistics"));
router.use("/", require("./commands"));
router.use("/", require("./games"));
router.use("/", require("./higherLower"));
router.use("/", require("./guessChatter"));
router.use("/", require("./about"));
router.use("/", require("./privacy"));
router.use("/", require("./requestBot"));
router.use("/", require("./admin"));
router.use("/", require("./adminAi"));
router.use("/", require("./adminApi"));
router.use("/", require("./seasonalTheme"));

// Channel-scoped routes go LAST, and channelRedirect goes last of all.
//
// Their first path segment is a wildcard, so mounting them ahead of the static pages above would
// let "/commands" or "/settings" be read as a CHANNEL named "commands"/"settings". userDashboard's
// paths are 3 segments deep ("/:channel/user/:username") so they can't collide, but
// channelRedirect owns a bare one-segment "/:channel" (the legacy dashboard URL, now a redirect
// to /:channel/statistics/chat) and would swallow every static page above it. Keep it the final
// mount.
router.use("/", require("./customCommands"));
router.use("/", require("./variables"));
router.use("/", require("./longBans"));
router.use("/", require("./donationMedia"));
router.use("/", require("./unbanBureau"));
router.use("/", require("./news"));
router.use("/", require("./movies"));
router.use("/", require("./gamesStream"));
router.use("/", require("./annualRecap"));
router.use("/", require("./userDashboard"));
router.use("/", require("./channelRedirect"));

module.exports = router;
