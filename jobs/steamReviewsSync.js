// Once a day: refresh Steam's review score on every game card with a Steam app id
// (lib/steamReviews.js). Same shape as jobs/imdbRatingsSync.js - the last run's outcome is stored in
// MediaSourceStatus (shown on /admin/media, and read at boot so a restart does not mean a fresh
// pass), one run at a time, an admin's "run now" joins a run in flight.
//
// `via` records which source answered (lib/steamReviews.js: the store, or SteamSpy when the store
// turns this network away). A "blocked" outcome (both refused) is recorded as a failure with that
// reason; the cards keep whatever score they had.
//
// A card saved with a Steam app it has no score for asks for an early run (requestSoon), the same
// way a film with a new IMDb id does: coalesced, a minute after the last such save and never closer
// than SOON_MIN_GAP_MS to the previous run.
const { connectWeb } = require("../db/connection");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const { fetchSteamReviews } = require("../lib/steamReviews");
const { fetchGameInfo } = require("../lib/steamGameInfo");

const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
// Later than the IMDb pass's boot delay, so the two never start together after a deploy.
const BOOT_DELAY_MS = 10 * 60 * 1000;
const STATUS_ID = "steamReviews";
const SOON_DELAY_MS = 60 * 1000;
const SOON_MIN_GAP_MS = 10 * 60 * 1000;
// The same pass fills genres/tags (lib/steamGameInfo.js) for cards that have none - each such app
// once, two requests apiece, paced like the reviews. A ceiling per pass keeps the first run after a
// deploy (every card at once) from taking an hour; the rest follow on the next passes.
const INFO_PER_PASS = 150;
const INFO_PACE_MS = 1500;

// Genres and tags for the cards still missing them. Stops at the first app both sources refused.
async function fillGameInfo(pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const ids = await mediaItemsRepo.steamAppIdsNeedingInfo(INFO_PER_PASS);
  let filled = 0;
  for (const [i, appId] of ids.entries()) {
    if (i > 0) await pause(INFO_PACE_MS);
    const { info, refused } = await fetchGameInfo(appId);
    if (info) {
      await mediaItemsRepo.setGameInfo(appId, info);
      filled++;
    } else if (refused.store && refused.steamspy) {
      break;
    }
  }
  return { wanted: ids.length, filled };
}

let inFlight = null;
let timer = null;
let nextRunAt = null;
let lastRunAt = null;

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
    lastRunAt = startedAt.getTime();
    const col = await statusCollection();
    try {
      const ids = await mediaItemsRepo.distinctSteamAppIds();
      const { found, asked, blocked, via } = await fetchSteamReviews(ids);
      const modified = await mediaItemsRepo.setExternalRatings("steam", "external.steamAppId", found, startedAt);
      // Genres/tags are not worth failing the scores over.
      const gameInfo = await fillGameInfo().catch((err) => {
        console.error("[steamReviewsSync] game info failed:", err.message);
        return null;
      });
      const status = {
        lastRunAt: startedAt,
        ok: !blocked,
        wanted: ids.length,
        asked,
        found: found.size,
        via,
        infoFilled: gameInfo ? gameInfo.filled : null,
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
  nextRunAt = Date.now() + delay;
  timer = setTimeout(async () => {
    await runOnce();
    schedule(RUN_EVERY_MS);
  }, delay);
  timer.unref();
}

function requestSoon() {
  if (nextRunAt === null) return; // the job was never started (tests, scripts)
  const earliest = Math.max(Date.now() + SOON_DELAY_MS, (lastRunAt || 0) + SOON_MIN_GAP_MS);
  if (earliest < nextRunAt) schedule(earliest - Date.now());
}

async function startSteamReviewsSync() {
  try {
    const status = await getStatus();
    if (status?.lastRunAt) lastRunAt = new Date(status.lastRunAt).getTime();
    const age = status?.lastRunAt ? Date.now() - new Date(status.lastRunAt).getTime() : Infinity;
    schedule(Math.max(BOOT_DELAY_MS, RUN_EVERY_MS - age));
  } catch (err) {
    console.error("[steamReviewsSync] could not read status, scheduling a run:", err.message);
    schedule(BOOT_DELAY_MS);
  }
}

module.exports = { startSteamReviewsSync, runOnce, getStatus, requestSoon, isRunning: () => Boolean(inFlight) };
