// IMDb's own ratings for the cards that have an IMDb id, from the official dataset
// (datasets.imdbws.com/title.ratings.tsv.gz: tconst, averageRating, numVotes - about 1.5 million
// lines, refreshed daily, ~9 MB compressed). No key and no request limit, and the number is exactly
// the viewers' rating IMDb shows. Licence: personal and non-commercial use, with the line
// "Information courtesy of IMDb" under the section (views/partials/mediaAttribution.ejs); if the
// site ever starts charging, this has to move to a licensed source.
//
// The file is never held whole: it is gunzipped as a stream and read line by line, and only lines
// whose tconst is in `wanted` (the ids that are actually on cards) are kept - a few hundred out of
// 1.5 million.
const zlib = require("zlib");
const readline = require("readline");
const { Readable, Transform } = require("stream");

const DATASET_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
// Generous against the ~9 MB file today; a response past this is not the file we expect.
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

// One data line -> {tconst, value, votes}, or null for the header or anything malformed.
function parseRatingLine(line) {
  const parts = line.split("\t");
  if (parts.length !== 3) return null;
  const [tconst, rating, votes] = parts;
  if (!/^tt\d{7,10}$/.test(tconst)) return null;
  const value = Number(rating);
  const count = Number(votes);
  if (!Number.isFinite(value) || value < 1 || value > 10 || !Number.isInteger(count) || count < 0) return null;
  return { tconst, value, votes: count };
}

// Counts compressed bytes as they pass and aborts past the ceiling.
function byteCeiling(max) {
  let total = 0;
  return new Transform({
    transform(chunk, enc, cb) {
      total += chunk.length;
      if (total > max) return cb(new Error("dataset larger than expected"));
      cb(null, chunk);
    },
  });
}

/**
 * Streams the dataset and returns Map<tconst, {value, votes}> for the ids in `wanted`.
 * @param {Set<string>} wanted
 * @param {{fetchImpl?: Function, url?: string}} [opts]
 */
async function fetchImdbRatings(wanted, { fetchImpl = fetch, url = DATASET_URL } = {}) {
  const found = new Map();
  if (!wanted || wanted.size === 0) return { found, lines: 0 };
  const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`dataset responded ${response.status}`);

  const input = Readable.fromWeb(response.body).pipe(byteCeiling(MAX_COMPRESSED_BYTES)).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lines = 0;
  try {
    for await (const line of rl) {
      lines++;
      // Cheap prefix test first: the tab split only runs for the ids we keep.
      const tab = line.indexOf("\t");
      if (tab < 0 || !wanted.has(line.slice(0, tab))) continue;
      const parsed = parseRatingLine(line);
      if (parsed) found.set(parsed.tconst, { value: parsed.value, votes: parsed.votes });
      if (found.size === wanted.size) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return { found, lines };
}

module.exports = { fetchImdbRatings, parseRatingLine, DATASET_URL };
