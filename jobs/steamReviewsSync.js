// Once a day: refresh Steam's review score on every game card with a Steam app id
// (lib/steamReviews.js). Same shape as jobs/imdbRatingsSync.js - the last run's outcome is stored in
// MediaSourceStatus (shown on /admin/media, and read at boot so a restart does not mean a fresh
// pass), one run at a time, an admin's "run now" joins a run in flight.
//
// A "blocked" outcome (Steam turned this network away) is recorded as a failure with that reason;
// the cards keep whatever score they had.
const { connectWeb } = require("../db/connection");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const { fetchSteamReviews } = require("../lib/steamReviews");

const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
// Later than the IMDb pass's boot delay, so the two never start together after a deploy.
const BOOT_DELAY_MS = 10 * 60 * 1000;
const STATUS_ID = "steamReviews";

let inFlight = null;
let timer = null;

async function statusCollection() {
  const db = await connectWeb();
  return db.collection("MediaSourceStatus");
}

async function getStatus() {
  return (await statusCollection()).findOne({ _id: STATUS_ID });
}

async function runOnce() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const startedAt = new Date();
    const col = await statusCollection();
    try {
      const ids = await mediaItemsRepo.distinctSteamAppIds();
      const { found, asked, blocked } = await fetchSteamReviews(ids);
      const modified = await mediaItemsRepo.setExternalRatings("steam", "external.steamAppId", found, startedAt);
      const status = {
        lastRunAt: startedAt,
        ok: !blocked,
        wanted: ids.length,
        asked,
        found: found.size,
        modified,
        durationMs: Date.now() - startedAt.getTime(),
        error: blocked ? "blocked" : null,
      };
      await col.updateOne({ _id: STATUS_ID }, { $set: status }, { upsert: true });
      return status;
    } catch (err) {
      console.error("[steamReviewsSync] run failed:", err.message);
      const status = { lastRunAt: startedAt, ok: false, durationMs: Date.now() - startedAt.getTime(), error: err.message };
      await col.updateOne({ _id: STATUS_ID }, { $set: status }, { upsert: true }).catch(() => {});
      return status;
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await runOnce();
    schedule(RUN_EVERY_MS);
  }, delay);
  timer.unref();
}

async function startSteamReviewsSync() {
  try {
    const status = await getStatus();
    const age = status?.lastRunAt ? Date.now() - new Date(status.lastRunAt).getTime() : Infinity;
    schedule(Math.max(BOOT_DELAY_MS, RUN_EVERY_MS - age));
  } catch (err) {
    console.error("[steamReviewsSync] could not read status, scheduling a run:", err.message);
    schedule(BOOT_DELAY_MS);
  }
}

module.exports = { startSteamReviewsSync, runOnce, getStatus, isRunning: () => Boolean(inFlight) };
