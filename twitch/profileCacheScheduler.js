// Self-rescheduling daily sweep of TwitchProfileCache (refresh stale entries,
// purge long-unused ones) - same resilience style as TwitchBot/twitch/TokenManager.js's
// self-rescheduling refresh loop: never let one failed sweep kill future ones.
const profileCacheRepo = require("../db/profileCacheRepo");

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

function startProfileCacheRefreshLoop() {
  async function runSweep() {
    try {
      const { refreshed, deleted } = await profileCacheRepo.sweepStaleAndUnused();
      console.log(`[profileCacheScheduler] sweep done: refreshed ${refreshed}, deleted ${deleted}`);
    } catch (err) {
      console.error("[profileCacheScheduler] sweep failed:", err.message);
    }
  }

  runSweep();
  setInterval(runSweep, SWEEP_INTERVAL_MS);
}

module.exports = { startProfileCacheRefreshLoop };
