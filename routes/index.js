const express = require("express");
const { authLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.use("/auth", authLimiter, require("./authRoutes"));
router.use("/", require("./home"));
router.use("/", require("./settings"));
router.use("/", require("./statistics"));
router.use("/", require("./commands"));
router.use("/", require("./games"));
router.use("/", require("./about"));

module.exports = router;
