// Steam's own review score for the game cards that have a Steam app id - the games' outside rating,
// as IMDb's is the films'. Asked app by app (store.steampowered.com/appreviews/<id>?json=1), paced,
// once a day (jobs/steamReviewsSync.js).
//
// Measured from the development machine (2026-11-13): every appreviews request - any game, any
// age, with or without an age cookie - was answered by a 302 to the store's front page, i.e. refused
// for this network. Whether the VPS gets real answers is not known yet. So a refusal is expected and
// handled as one: the first 3xx/403 stops the whole pass (asking the remaining hundred apps would
// only add a hundred refusals) and is recorded as "blocked", which /admin/media shows. Cards then
// simply have no Steam score; nothing else depends on it.
const { getJson, SourceError } = require("./mediaSources/http");

const PACE_MS = 1500;

// The share of positive reviews (0-100, one decimal) and the review count, or null with no reviews.
function scoreFromSummary(summary) {
  const total = Number(summary?.total_reviews);
  const positive = Number(summary?.total_positive);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(positive) || positive < 0) return null;
  return { value: Math.round((positive / total) * 1000) / 10, votes: total };
}

/**
 * @param {number[]} appIds
 * @returns {Promise<{found: Map<number, {value, votes}>, asked: number, blocked: boolean}>}
 */
async function fetchSteamReviews(appIds, { fetchImpl, pause = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = PACE_MS } = {}) {
  const found = new Map();
  let asked = 0;
  for (const appId of appIds) {
    if (asked > 0) await pause(paceMs);
    asked++;
    try {
      const body = await getJson(
        `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`,
        { fetchImpl }
      );
      const score = body && body.success === 1 ? scoreFromSummary(body.query_summary) : null;
      if (score) found.set(appId, score);
    } catch (err) {
      // A redirect or a refusal is the store turning this network away: stop, report "blocked".
      if (err instanceof SourceError && /status (3\d\d|403|429)/.test(err.message)) return { found, asked, blocked: true };
      // Anything else is about this one app; carry on with the next.
    }
  }
  return { found, asked, blocked: false };
}

module.exports = { fetchSteamReviews, scoreFromSummary, PACE_MS };
