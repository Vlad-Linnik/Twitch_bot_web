const express = require("express");
const { authLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.use("/auth", authLimiter, require("./authRoutes"));
router.use("/", require("./home"));
router.use("/", require("./accountSettings"));
router.use("/", require("./settings"));
router.use("/", require("./statistics"));
router.use("/", require("./commands"));
router.use("/", require("./games"));
router.use("/", require("./about"));

// Channel-scoped routes go LAST, and channelDashboard goes last of all.
//
// Their first path segment is a wildcard, so mounting them ahead of the static pages above would
// let "/commands" or "/settings" be read as a CHANNEL named "commands"/"settings". userDashboard's
// paths are 3 segments deep ("/:channel/user/:username") so they can't collide, but
// channelDashboard owns a bare one-segment "/:channel" and would swallow every static page above
// it. Keep it the final mount.
router.use("/", require("./customCommands"));
router.use("/", require("./counters"));
router.use("/", require("./userDashboard"));
router.use("/", require("./channelDashboard"));

module.exports = router;
