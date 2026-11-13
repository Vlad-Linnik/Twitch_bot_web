// Pure half of the slow-request tool (middleware/requestTiming.js records, db/requestTimingRepo.js
// stores, /admin/slow-requests reads). Kept free of Express and Mongo so the arithmetic can be
// tested on its own.
//
// Why a histogram and not a list of durations: a percentile over "requests slower than the
// threshold" is meaningless - its p50 is always above the threshold by construction. To say what a
// route's p50/p95 really is, EVERY request has to be counted, and storing every duration is a row
// per page view. A fixed set of buckets per (hour, method, route) is a handful of counters instead,
// costs one upsert per route per flush, and - the property that matters - merges by plain addition,
// so a 30-day window is the sum of 720 hourly rows. The price is resolution: a percentile is
// interpolated inside its bucket, so it is exact only up to the bucket's width. The bounds are
// dense where pages normally live (tens to hundreds of ms) and coarse in the tail.
//
// FROZEN: stored rows hold counts keyed by bucket index. Changing BUCKET_BOUNDS_MS reinterprets
// every row already written, so a change must come with a new HISTOGRAM_VERSION (the repo only
// reads rows of the current version; old ones expire on their TTL).
const BUCKET_BOUNDS_MS = [
  5, 10, 20, 35, 50, 75, 100, 150, 200, 300, 400, 500, 750,
  1000, 1500, 2000, 3000, 5000, 7500, 10000, 20000, 30000, 60000,
];
const HISTOGRAM_VERSION = 1;

// Upper-inclusive: a 5ms request lands in bucket 0 ("<= 5ms"). Anything past the last bound goes
// into one overflow bucket whose upper edge is the route's own observed max.
function bucketIndex(ms) {
  for (let i = 0; i < BUCKET_BOUNDS_MS.length; i++) {
    if (ms <= BUCKET_BOUNDS_MS[i]) return i;
  }
  return BUCKET_BOUNDS_MS.length;
}

function emptyAccumulator() {
  return {
    count: 0,
    sumMs: 0,
    maxMs: 0,
    sumDbMs: 0,
    dbCount: 0,
    sumRenderMs: 0,
    renderCount: 0,
    errors: 0,
    aborted: 0,
    hist: {},
  };
}

// sample: { totalMs, dbMs, dbCount, renderMs, renderCount, status, aborted }
function addSample(acc, sample) {
  const ms = Math.max(0, Number(sample.totalMs) || 0);
  acc.count += 1;
  acc.sumMs += ms;
  if (ms > acc.maxMs) acc.maxMs = ms;
  acc.sumDbMs += sample.dbMs || 0;
  acc.dbCount += sample.dbCount || 0;
  acc.sumRenderMs += sample.renderMs || 0;
  acc.renderCount += sample.renderCount || 0;
  if (sample.status >= 500) acc.errors += 1;
  if (sample.aborted) acc.aborted += 1;
  const i = bucketIndex(ms);
  acc.hist[i] = (acc.hist[i] || 0) + 1;
  return acc;
}

// Adds a stored row (or another accumulator) into acc. Rows read back from Mongo carry `hist` as
// an object with string keys ("3": 12), which is exactly what $inc on "hist.3" produces.
function mergeInto(acc, row) {
  acc.count += row.count || 0;
  acc.sumMs += row.sumMs || 0;
  if ((row.maxMs || 0) > acc.maxMs) acc.maxMs = row.maxMs;
  acc.sumDbMs += row.sumDbMs || 0;
  acc.dbCount += row.dbCount || 0;
  acc.sumRenderMs += row.sumRenderMs || 0;
  acc.renderCount += row.renderCount || 0;
  acc.errors += row.errors || 0;
  acc.aborted += row.aborted || 0;
  for (const [key, n] of Object.entries(row.hist || {})) {
    acc.hist[key] = (acc.hist[key] || 0) + (n || 0);
  }
  return acc;
}

// p in [0, 1]. Finds the bucket holding the rank p*count and interpolates linearly inside it,
// i.e. assumes the samples in one bucket are spread evenly across its width. The result never
// exceeds the observed max - the overflow bucket has no upper bound of its own, and a sparse
// bucket would otherwise report a value nobody actually waited.
function percentileFromHistogram(hist, count, p, maxMs) {
  if (!count) return null;
  const rank = Math.min(count, Math.max(0, p * count));
  let cumulative = 0;
  for (let i = 0; i <= BUCKET_BOUNDS_MS.length; i++) {
    const inBucket = Number(hist[i] || 0); // stored keys are strings; obj[3] and obj["3"] are one key
    if (!inBucket) continue;
    if (cumulative + inBucket >= rank) {
      const lower = i === 0 ? 0 : BUCKET_BOUNDS_MS[i - 1];
      const upper = i < BUCKET_BOUNDS_MS.length ? Math.min(BUCKET_BOUNDS_MS[i], maxMs) : maxMs;
      const fraction = (rank - cumulative) / inBucket;
      const value = lower + fraction * Math.max(0, upper - lower);
      return Math.min(value, maxMs);
    }
    cumulative += inBucket;
  }
  return maxMs;
}

const SORT_KEYS = ["p95", "p50", "max", "count", "total"];

// rows: stored hourly rows ({ method, route, ...accumulator fields }). Returns one line per
// (method, route) over the whole window. "total" = the time the server spent on that route in
// sum, which is how a fast-but-hammered route (stats.json polling) shows up next to a slow-but-
// rare one; sorting by p95 alone would never surface it.
function summarizeRoutes(rows, { sortBy = "p95", limit = 50 } = {}) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.method} ${row.route}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { method: row.method, route: row.route, acc: emptyAccumulator() };
      byKey.set(key, entry);
    }
    mergeInto(entry.acc, row);
  }

  const lines = [];
  for (const { method, route, acc } of byKey.values()) {
    if (!acc.count) continue;
    lines.push({
      method,
      route,
      count: acc.count,
      p50: percentileFromHistogram(acc.hist, acc.count, 0.5, acc.maxMs),
      p95: percentileFromHistogram(acc.hist, acc.count, 0.95, acc.maxMs),
      max: acc.maxMs,
      avgMs: acc.sumMs / acc.count,
      totalMs: acc.sumMs,
      avgDbMs: acc.sumDbMs / acc.count,
      avgDbCount: acc.dbCount / acc.count,
      // Averaged over the requests that rendered at all - a JSON endpoint renders nothing, and
      // dividing by its count would make a slow template look cheap.
      avgRenderMs: acc.renderCount ? acc.sumRenderMs / acc.renderCount : null,
      errors: acc.errors,
      aborted: acc.aborted,
    });
  }

  const key = SORT_KEYS.includes(sortBy) ? sortBy : "p95";
  const value = (line) => (key === "total" ? line.totalMs : line[key]);
  lines.sort((a, b) => value(b) - value(a) || b.count - a.count);
  return limit ? lines.slice(0, limit) : lines;
}

// The label a request is stored under. Must never contain anything a visitor typed: no query
// string, no channel login, no username - which is why it is the route PATTERN
// ("/:channel/statistics/chat") and not req.path.
//
// baseUrl is the one caveat: Express fills it with the ACTUAL matched prefix, not the mount
// pattern. Every router in routes/index.js is mounted on a literal ("/" or "/auth"), so it is safe
// today; a router mounted on "/:something" would leak that segment here, and the defence below
// replaces any baseUrl segment that equals a request param with the param's name.
//
// No route matched: a request with a file extension is the static middleware's (or a probe for a
// file that is not there), everything else is a 404 page or a middleware that answered on its own
// (rate limiter, CSRF). Their paths are exactly the part that must not be stored - scanners alone
// would fill the table with one row per probed URL.
function normalizeRoute({ baseUrl, routePath, params, path }) {
  if (routePath === undefined || routePath === null) {
    return /\.[a-z0-9]{1,8}$/i.test(path || "") ? "(static)" : "(no route)";
  }
  let base = baseUrl || "";
  if (base && params) {
    const byValue = new Map(Object.entries(params).map(([name, value]) => [String(value), name]));
    base = base
      .split("/")
      .map((segment) => (byValue.has(segment) ? `:${byValue.get(segment)}` : segment))
      .join("/");
  }
  const pattern = routePath instanceof RegExp ? routePath.toString() : Array.isArray(routePath) ? routePath.join("|") : String(routePath);
  const joined = `${base}${pattern === "/" && base ? "" : pattern}`;
  return joined || "/";
}

module.exports = {
  BUCKET_BOUNDS_MS,
  HISTOGRAM_VERSION,
  SORT_KEYS,
  bucketIndex,
  emptyAccumulator,
  addSample,
  mergeInto,
  percentileFromHistogram,
  summarizeRoutes,
  normalizeRoute,
};
