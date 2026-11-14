// Once a day: refresh the IMDb rating of every card that has an IMDb id (lib/imdbRatings.js).
//
// The last run's outcome is stored (MediaSourceStatus, web db) rather than kept in memory, for two
// reasons: /admin/media shows it, and a restart must not mean a fresh download - pm2 restarts on
// every deploy, and IMDb refreshes the file once a day anyway. On boot the job runs only if the
// stored run is older than RUN_EVERY_MS; otherwise it waits out the remainder.
//
// One run at a time: an admin's "run now" while the timer's run is in flight joins it instead of
// starting a second download.
const { connectWeb } = require("../db/connection");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const { fetchImdbRatings } = require("../lib/imdbRatings");

const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
// Not in the first minutes after boot: a deploy restarts the process, and the site's own start-up
// work comes first.
const BOOT_DELAY_MS = 5 * 60 * 1000;
const STATUS_ID = "imdbRatings";

// A card saved with an IMDb id it has no rating for asks for an early run (requestSoon) instead
// of waiting out the day. Coalesced: a burst of new cards is one download, a little after the
// last of them, and never closer than SOON_MIN_GAP_MS to the previous run - the file is ~9 MB and
// IMDb rebuilds it once a day, so running it more often only re-reads the same numbers.
const SOON_DELAY_MS = 60 * 1000;
const SOON_MIN_GAP_MS = 10 * 60 * 1000;

let inFlight = null;
let timer = null;
let nextRunAt = null;
let lastRunAt = null;

async function statusCollection() {
  const db = await connectWeb();
  return db.collection("MediaSourceStatus");
}

async function getStatus() {
  const col = await statusCollection();
  return col.findOne({ _id: STATUS_ID });
}

async function runOnce() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const startedAt = new Date();
    lastRunAt = startedAt.getTime();
    const col = await statusCollection();
    try {
      const ids = await mediaItemsRepo.distinctImdbIds();
      const { found, lines } = await fetchImdbRatings(new Set(ids));
      const modified = await mediaItemsRepo.setImdbRatings(found, startedAt);
      const status = {
        lastRunAt: startedAt,
        ok: true,
        wanted: ids.length,
        found: found.size,
        modified,
        lines,
        durationMs: Date.now() - startedAt.getTime(),
        error: null,
      };
      await col.updateOne({ _id: STATUS_ID }, { $set: status }, { upsert: true });
      return status;
    } catch (err) {
      console.error("[imdbRatingsSync] run failed:", err.message);
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
  nextRunAt = Date.now() + delay;
  timer = setTimeout(async () => {
    await runOnce();
    schedule(RUN_EVERY_MS);
  }, delay);
  timer.unref();
}

// An early run for a card that just got an IMDb id. Only ever moves the next run EARLIER; the
// daily rhythm resumes after it (schedule() re-arms RUN_EVERY_MS once a run finishes).
function requestSoon() {
  if (nextRunAt === null) return; // the job was never started (tests, scripts)
  const earliest = Math.max(Date.now() + SOON_DELAY_MS, (lastRunAt || 0) + SOON_MIN_GAP_MS);
  if (earliest < nextRunAt) schedule(earliest - Date.now());
}

async function startImdbRatingsSync() {
  try {
    const status = await getStatus();
    if (status?.lastRunAt) lastRunAt = new Date(status.lastRunAt).getTime();
    const age = status?.lastRunAt ? Date.now() - new Date(status.lastRunAt).getTime() : Infinity;
    schedule(Math.max(BOOT_DELAY_MS, RUN_EVERY_MS - age));
  } catch (err) {
    console.error("[imdbRatingsSync] could not read status, scheduling a run:", err.message);
    schedule(BOOT_DELAY_MS);
  }
}

module.exports = { startImdbRatingsSync, runOnce, getStatus, requestSoon, isRunning: () => Boolean(inFlight) };
