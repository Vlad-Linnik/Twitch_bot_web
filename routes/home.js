const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const globalStatsRepo = require("../db/globalStatsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const streamStatus = require("../twitch/streamStatus");
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
    const [channelDocs, stats] = await Promise.all([channelsRepo.listVisibleOnHomepage(), loadGlobalStats()]);

    // ownerId doubles as the channel's numeric broadcaster/channelId (see channelsRepo.upsertChannel).
    const ownerIds = channelDocs.map((c) => c.ownerId);
    const [profiles, liveIds] = await Promise.all([
      profileCacheRepo.getOrFetchProfiles(ownerIds),
      streamStatus.getLiveChannelIds(ownerIds),
    ]);

    const channels = channelDocs
      .map((c) => {
        const profile = profiles.get(String(c.ownerId));
        return {
          ...c,
          avatarUrl: profile?.avatarUrl || null,
          chatColor: profile?.chatColor || null,
          isLive: liveIds.has(String(c.ownerId)),
        };
      })
      // Live channels first (dimmed offline ones pushed to the end), alphabetical within each
      // group so the order is stable across requests instead of following DB insertion order.
      .sort((a, b) => {
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
        return a.channelLogin.localeCompare(b.channelLogin);
      });

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
