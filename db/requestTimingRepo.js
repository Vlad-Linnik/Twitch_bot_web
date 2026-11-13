// Storage for the slow-request tool (middleware/requestTiming.js writes, /admin/slow-requests
// reads). Web db: the bot never reads these, and they describe this process, not chat.
//
// Two collections because they answer two questions:
//   RequestTimingHourly - one row per (hour, method, route): a histogram of EVERY request, so the
//                         page can state a real p50/p95 (lib/requestTiming.js explains the shape).
//   SlowRequests        - one row per request over the threshold, with its own breakdown (DB wait,
//                         EJS render, the slowest Mongo commands), so a single bad load can be
//                         looked at rather than only counted.
// Neither carries anything a visitor typed: the route is the pattern, never the path, and there is
// no user id, IP, query string or channel login.
const { connectWeb } = require("./connection");
const { HISTOGRAM_VERSION } = require("../lib/requestTiming");

const HOURLY = "RequestTimingHourly";
const SLOW = "SlowRequests";
// Histograms are a few counters per route per hour, so a month is cheap and covers "it was slow
// last week". Individual slow rows are kept shorter - they exist to be looked at while the problem
// is fresh.
const HOURLY_RETENTION_DAYS = 30;
const SLOW_RETENTION_DAYS = 14;

let collections = null;
let initializing = null;

async function ensureInitialized() {
  if (collections) return collections;
  if (!initializing) initializing = init().finally(() => (initializing = null));
  return initializing;
}

async function init() {
  const db = await connectWeb();
  const hourly = db.collection(HOURLY);
  const slow = db.collection(SLOW);
  // Indexes are not needed to serve a page, so failing to create one must not fail it - see
  // CLAUDE.md's "A repo's ensureInitialized() must not be able to fail a page render".
  const wanted = [
    [hourly, { hour: 1, method: 1, route: 1, v: 1 }, { unique: true }],
    [hourly, { hour: 1 }, { name: "hour_ttl", expireAfterSeconds: HOURLY_RETENTION_DAYS * 86400 }],
    [slow, { at: 1 }, { name: "at_ttl", expireAfterSeconds: SLOW_RETENTION_DAYS * 86400 }],
    [slow, { route: 1, at: -1 }, {}],
  ];
  for (const [col, key, options] of wanted) {
    try {
      await col.createIndex(key, options);
    } catch (err) {
      console.error(`[requestTimingRepo] createIndex ${col.collectionName} ${JSON.stringify(key)} failed:`, err.message);
    }
  }
  collections = { hourly, slow };
  return collections;
}

// hourlyRows: [{ hour: Date, method, route, acc }] where acc is a lib/requestTiming.js accumulator.
// One $inc upsert per row; the histogram goes in as "hist.<i>" so concurrent flushes (there are
// none today - one process - but pm2 cluster mode would make them real) add rather than overwrite.
async function flush(hourlyRows, slowRows) {
  const { hourly, slow } = await ensureInitialized();
  const work = [];
  if (hourlyRows.length) {
    const ops = hourlyRows.map(({ hour, method, route, acc }) => {
      const inc = {
        count: acc.count,
        sumMs: acc.sumMs,
        sumDbMs: acc.sumDbMs,
        dbCount: acc.dbCount,
        sumRenderMs: acc.sumRenderMs,
        renderCount: acc.renderCount,
        errors: acc.errors,
        aborted: acc.aborted,
      };
      for (const [i, n] of Object.entries(acc.hist)) inc[`hist.${i}`] = n;
      return {
        updateOne: {
          filter: { hour, method, route, v: HISTOGRAM_VERSION },
          update: { $inc: inc, $max: { maxMs: acc.maxMs } },
          upsert: true,
        },
      };
    });
    work.push(hourly.bulkWrite(ops, { ordered: false }));
  }
  if (slowRows.length) work.push(slow.insertMany(slowRows, { ordered: false }));
  await Promise.all(work);
}

async function getHourlyRows(days) {
  const { hourly } = await ensureInitialized();
  const since = new Date(Date.now() - days * 86400 * 1000);
  return hourly
    .find({ hour: { $gte: since }, v: HISTOGRAM_VERSION }, { projection: { _id: 0 } })
    .toArray();
}

async function getRecentSlow({ days, route, limit = 100 }) {
  const { slow } = await ensureInitialized();
  const filter = { at: { $gte: new Date(Date.now() - days * 86400 * 1000) } };
  if (route) filter.route = route;
  return slow.find(filter, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
}

async function countSlow(days) {
  const { slow } = await ensureInitialized();
  return slow.countDocuments({ at: { $gte: new Date(Date.now() - days * 86400 * 1000) } });
}

module.exports = {
  flush,
  getHourlyRows,
  getRecentSlow,
  countSlow,
  HOURLY_RETENTION_DAYS,
  SLOW_RETENTION_DAYS,
};
