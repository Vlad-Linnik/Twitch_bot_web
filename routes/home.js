const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const globalStatsRepo = require("../db/globalStatsRepo");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const [channels, commandsExecuted, emoteStats, uniqueUsers] = await Promise.all([
      channelsRepo.listEnabled(),
      globalStatsRepo.getGlobalCommandCount(),
      globalStatsRepo.getGlobalEmoteStats(),
      globalStatsRepo.getGlobalUniqueUserCount(),
    ]);

    res.render("home", { channels, commandsExecuted, emoteStats, uniqueUsers });
  } catch (err) {
    next(err);
  }
});

module.exports = router;