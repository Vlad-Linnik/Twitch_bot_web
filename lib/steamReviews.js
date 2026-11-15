// Steam's own review score for the game cards that have a Steam app id - the games' outside rating,
// as IMDb's is the films'. Asked app by app, paced, once a day and soon after a card with a new Steam
// app is saved (jobs/steamReviewsSync.js).
//
// Two sources for the same two numbers (positive and total reviews, every language, every purchase
// type):
//   - the store itself, store.steampowered.com/appreviews/<id>?json=1 - first, it is the original;
//   - SteamSpy's appdetails (steamspy.com/api.php) - when the store turns this network away. Measured
//     from the development machine (2026-11-13, again 2026-11-15): every appreviews request was
//     answered by a 302 to the store's front page, while SteamSpy answered with the counts (Dota 2:
//     2 037 143 positive / 461 826 negative = 81.5%, the figure the store page shows). SteamSpy asks
//     for at most one appdetails request a second; PACE_MS stays above that.
// The first refusal (3xx/403/429) from the store switches the rest of the pass to SteamSpy - asking
// the remaining hundred apps would only add a hundred refusals. "blocked" now means both refused.
const { getJson, SourceError } = require("./mediaSources/http");

const PACE_MS = 1500;
const REFUSED = /status (3\d\d|403|429)/;

// The share of positive reviews (0-100, one decimal) and the review count, or null with no reviews.
function scoreFromSummary(summary) {
  const total = Number(summary?.total_reviews);
  const positive = Number(summary?.total_positive);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(positive) || positive < 0) return null;
  return { value: Math.round((positive / total) * 1000) / 10, votes: total };
}

// SteamSpy's appdetails answer, in the store summary's terms. An unknown app comes back with zeros.
function scoreFromSteamSpy(body) {
  const positive = Number(body?.positive);
  const negative = Number(body?.negative);
  if (!Number.isFinite(positive) || !Number.isFinite(negative) || positive < 0 || negative < 0) return null;
  return scoreFromSummary({ total_reviews: positive + negative, total_positive: positive });
}

const storeUrl = (appId) =>
  `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`;
const steamSpyUrl = (appId) => `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;

/**
 * @param {number[]} appIds
 * @returns {Promise<{found: Map<number, {value, votes}>, asked: number, blocked: boolean, via: "store"|"steamspy"}>}
 */
async function fetchSteamReviews(appIds, { fetchImpl, pause = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = PACE_MS } = {}) {
  const found = new Map();
  let asked = 0;
  let via = "store";
  for (const appId of appIds) {
    if (asked > 0) await pause(paceMs);
    asked++;
    if (via === "store") {
      try {
        const body = await getJson(storeUrl(appId), { fetchImpl });
        const score = body && body.success === 1 ? scoreFromSummary(body.query_summary) : null;
        if (score) found.set(appId, score);
        continue;
      } catch (err) {
        // Anything but a refusal is about this one app; carry on with the next.
        if (!(err instanceof SourceError && REFUSED.test(err.message))) continue;
        // The store turned this network away: this app and the rest go to SteamSpy.
        via = "steamspy";
        await pause(paceMs);
      }
    }
    try {
      const score = scoreFromSteamSpy(await getJson(steamSpyUrl(appId), { fetchImpl }));
      if (score) found.set(appId, score);
    } catch (err) {
      if (err instanceof SourceError && REFUSED.test(err.message)) return { found, asked, blocked: true, via };
    }
  }
  return { found, asked, blocked: false, via };
}

module.exports = { fetchSteamReviews, scoreFromSummary, scoreFromSteamSpy, PACE_MS };
