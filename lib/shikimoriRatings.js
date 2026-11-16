// Shikimori's own users' score for the anime cards that have no IMDb rating - not every title is on
// IMDb, and an anime picked in the Shikimori tab has no IMDb id at all. Asked app by app, paced,
// by the same daily pass as IMDb's (jobs/imdbRatingsSync.js), and only for cards IMDb did not rate:
// a card with an IMDb rating keeps it.
//
// The `score` field of Shikimori's API is MyAnimeList's figure, not Shikimori's (the site shows it
// as such). What Shikimori's own users gave is `rates_scores_stats`, the count of each mark 1-10;
// the average of that is the score stored here, and the sum is its vote count - the two numbers
// describe the same people.
const { getJson, SourceError } = require("./mediaSources/http");

const ORIGIN = "https://shikimori.io";
// Shikimori allows 5 requests a second and 90 a minute; one a second stays well inside both.
const PACE_MS = 1000;
const REFUSED = /status (3\d\d|403|429)/;

// {value: average 1-10, one decimal, votes} from the mark counts, or null with no marks.
function scoreFromStats(stats) {
  let votes = 0;
  let sum = 0;
  for (const row of Array.isArray(stats) ? stats : []) {
    const mark = Number(row && row.name);
    const count = Number(row && row.value);
    if (!Number.isInteger(mark) || mark < 1 || mark > 10 || !Number.isFinite(count) || count <= 0) continue;
    votes += count;
    sum += mark * count;
  }
  return votes > 0 ? { value: Math.round((sum / votes) * 10) / 10, votes } : null;
}

/**
 * @param {number[]} ids Shikimori anime ids
 * @returns {Promise<{found: Map<number, {value, votes}>, asked: number, blocked: boolean}>}
 */
async function fetchShikimoriRatings(ids, { fetchImpl, pause = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = PACE_MS } = {}) {
  const found = new Map();
  let asked = 0;
  for (const id of ids) {
    if (asked > 0) await pause(paceMs);
    asked++;
    try {
      const body = await getJson(`${ORIGIN}/api/animes/${id}`, { fetchImpl });
      const score = scoreFromStats(body && body.rates_scores_stats);
      if (score) found.set(id, score);
    } catch (err) {
      // A refusal is about this network, not this title: stop rather than ask the rest.
      if (err instanceof SourceError && REFUSED.test(err.message)) return { found, asked, blocked: true };
    }
  }
  return { found, asked, blocked: false };
}

const shikimoriUrl = (id) => `${ORIGIN}/animes/${id}`;

module.exports = { fetchShikimoriRatings, scoreFromStats, shikimoriUrl, PACE_MS };
