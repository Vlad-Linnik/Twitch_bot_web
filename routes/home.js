const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const globalStatsRepo = require("../db/globalStatsRepo");
const { statsReadLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

async function loadGlobalStats() {
  const [commandsExecuted, emoteStats, uniqueUsers] = await Promise.all([
    globalStatsRepo.getGlobalCommandCount(),
    globalStatsRepo.getGlobalEmoteStats(),
    globalStatsRepo.getGlobalUniqueUserCount(),
  ]);
  return { commandsExecuted, emoteStats, uniqueUsers };
}

router.get("/", async (req, res, next) => {
  try {
    const [channels, stats] = await Promise.all([channelsRepo.listEnabled(), loadGlobalStats()]);
    res.render("home", { channels, ...stats });
  } catch (err) {
    next(err);
  }
});

// Polled by public/js/home-stats.js to keep the four stat tiles live without a reload. Flat
// keys matching the tiles' data-stat attributes. Same reads the page render does (all cheap -
// see globalStatsRepo), and statsReadLimiter caps how hard an anonymous visitor can loop it.
router.get("/stats.json", statsReadLimiter, async (req, res, next) => {
  try {
    const { commandsExecuted, emoteStats, uniqueUsers } = await loadGlobalStats();
    res.json({
      commandsExecuted,
      emotesUsed: emoteStats.totalUsageCount,
      emotesTracked: emoteStats.totalEntriesAdded,
      uniqueUsers,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
