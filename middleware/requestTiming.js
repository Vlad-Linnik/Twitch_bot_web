// Measures every HTTP request end to end and keeps what /admin/slow-requests shows: a histogram per
// route for all of them, and a detailed row for each one slower than env.slowRequestMs. Mounted
// first in app.js so the number includes everything the visitor waited for on our side - session
// lookup, permission checks, Mongo, the EJS render, compression.
//
// The breakdown attached to each request comes from two hooks, neither of which touches a repo or
// a route:
//   * Mongo: the driver's command monitoring (db/connection.js turns it on). Each command's start
//     is attributed to the request whose async context issued it, via AsyncLocalStorage, so every
//     aggregation statsRepo/wordStatsRepo/userStatsRepo runs is counted against the page that
//     asked for it. `dbMs` is WALL time with at least one command in flight, not the sum of
//     command durations - a page that runs five aggregations in a Promise.all waits for the
//     slowest, and a sum would claim it waited for all five back to back. The slowest individual
//     commands are kept by name and collection, which is what says WHICH aggregation it was.
//   * EJS: res.render is wrapped for the request, timing template execution up to the HTML string.
//     In development Express does not cache compiled views, so dev render times include compiling
//     the template and read higher than production's.
// Whatever is left (total - db - render) is our own JS, awaits on Twitch's API, and time spent
// writing the response.
//
// Cost on the request path: two hrtime reads, a closure, an object per request, and a Map lookup
// per Mongo command. Nothing is written to Mongo from here - results go into in-memory buffers that
// a timer flushes every FLUSH_INTERVAL_MS, and a failed flush is logged and dropped. Nothing in this
// file can fail a request: every hook is wrapped so that an exception in measurement is swallowed.
//
// Known limits: `totalMs` ends at 'finish', which for a large body (a sound file, a big static
// asset) includes waiting for the socket to drain, i.e. the visitor's bandwidth - `ttfbMs` (headers
// handed to Node) is the number that is purely ours. A restart loses up to one flush interval of
// counters. WebSocket traffic (realtime/) never passes through Express and is not measured.
const { AsyncLocalStorage } = require("node:async_hooks");
const env = require("../config/env");
const { getClient } = require("../db/connection");
const requestTimingRepo = require("../db/requestTimingRepo");
const { emptyAccumulator, addSample, normalizeRoute } = require("../lib/requestTiming");

const FLUSH_INTERVAL_MS = 15_000;
// A cap on what waits for the next flush. Reached only if Mongo is unreachable while traffic keeps
// coming; past it the oldest slow rows are dropped rather than growing the heap.
const MAX_BUFFERED_SLOW = 500;
const TOP_DB_OPS = 3;
const HOUR_MS = 3_600_000;

const als = new AsyncLocalStorage();

let hourlyBuffer = new Map(); // "<hourMs>\0<method>\0<route>" -> { hour, method, route, acc }
let slowBuffer = [];

const nowNs = () => process.hrtime.bigint();
const msBetween = (fromNs, toNs) => Number(toNs - fromNs) / 1e6;
const round1 = (ms) => Math.round(ms * 10) / 10;

// --- Mongo command attribution ----------------------------------------------------------------
// commandStarted runs synchronously inside the operation the route awaited, so the request's
// AsyncLocalStorage store is visible there. commandSucceeded/Failed fire from the socket's data
// handler, where it is not - hence the requestId -> store map bridging the two.
const inFlight = new Map();
const MAX_IN_FLIGHT = 10_000; // only reachable if the driver ever stopped emitting end events

function collectionOf(event) {
  const command = event.command || {};
  const target = command[event.commandName];
  if (typeof target === "string") return target;
  if (typeof command.collection === "string") return command.collection; // getMore
  return null;
}

function onCommandStarted(event) {
  try {
    const store = als.getStore();
    if (!store || store.finished) return;
    if (inFlight.size >= MAX_IN_FLIGHT) inFlight.clear();
    inFlight.set(event.requestId, { store, op: event.commandName, coll: collectionOf(event) });
    store.dbCount += 1;
    if (store.dbActive++ === 0) store.dbBusySince = nowNs();
  } catch {
    // measurement must never break a query
  }
}

function onCommandEnded(event) {
  try {
    const entry = inFlight.get(event.requestId);
    if (!entry) return;
    inFlight.delete(event.requestId);
    const { store } = entry;
    if (store.dbActive > 0 && --store.dbActive === 0 && store.dbBusySince) {
      store.dbBusyMs += msBetween(store.dbBusySince, nowNs());
      store.dbBusySince = null;
    }
    const ms = Number(event.duration) || 0;
    const ops = store.dbOps;
    // No `failed: undefined` - the driver stores an undefined field as null.
    const op = { op: entry.op, coll: entry.coll, ms: round1(ms) };
    if (event.failure) op.failed = true;
    if (ops.length < TOP_DB_OPS) {
      ops.push(op);
    } else {
      let minIdx = 0;
      for (let i = 1; i < ops.length; i++) if (ops[i].ms < ops[minIdx].ms) minIdx = i;
      if (ms > ops[minIdx].ms) ops[minIdx] = op;
    }
  } catch {
    // see onCommandStarted
  }
}

const client = getClient();
client.on("commandStarted", onCommandStarted);
client.on("commandSucceeded", onCommandEnded);
client.on("commandFailed", onCommandEnded);

// --- Recording ----------------------------------------------------------------------------------
function record(req, res, store, endNs, aborted) {
  const totalMs = msBetween(store.startNs, endNs);
  let dbMs = store.dbBusyMs;
  if (store.dbActive > 0 && store.dbBusySince) dbMs += msBetween(store.dbBusySince, endNs);

  const route = normalizeRoute({
    baseUrl: req.baseUrl,
    routePath: req.route ? req.route.path : undefined,
    params: req.params,
    path: req.path,
  });
  const method = req.method;
  const status = res.statusCode;
  const sample = {
    totalMs,
    dbMs,
    dbCount: store.dbCount,
    renderMs: store.renderMs,
    renderCount: store.renderCount,
    status,
    aborted,
  };

  const hourMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const key = `${hourMs}\0${method}\0${route}`;
  let bucket = hourlyBuffer.get(key);
  if (!bucket) {
    bucket = { hour: new Date(hourMs), method, route, acc: emptyAccumulator() };
    hourlyBuffer.set(key, bucket);
  }
  addSample(bucket.acc, sample);

  if (totalMs >= env.slowRequestMs) {
    if (slowBuffer.length >= MAX_BUFFERED_SLOW) slowBuffer.shift();
    const row = {
      at: new Date(),
      method,
      route,
      status,
      totalMs: round1(totalMs),
      ttfbMs: store.headersNs ? round1(msBetween(store.startNs, store.headersNs)) : null,
      dbMs: round1(dbMs),
      dbCount: store.dbCount,
      renderMs: store.renderCount ? round1(store.renderMs) : null,
      dbOps: [...store.dbOps].sort((a, b) => b.ms - a.ms),
    };
    if (aborted) row.aborted = true;
    slowBuffer.push(row);
  }
}

function requestTiming(req, res, next) {
  const store = {
    startNs: nowNs(),
    headersNs: null,
    dbCount: 0,
    dbActive: 0,
    dbBusySince: null,
    dbBusyMs: 0,
    dbOps: [],
    renderMs: 0,
    renderCount: 0,
    finished: false,
  };

  try {
    // Headers leaving = the server has decided the response. Node's implicit header path
    // (res.end() without an explicit writeHead) also goes through this method.
    const originalWriteHead = res.writeHead;
    res.writeHead = function timedWriteHead(...args) {
      if (!store.headersNs) store.headersNs = nowNs();
      return originalWriteHead.apply(this, args);
    };

    // Same signature and default callback as Express 4's res.render, plus a stopwatch.
    const originalRender = res.render;
    res.render = function timedRender(view, options, callback) {
      let opts = options;
      let done = callback;
      if (typeof opts === "function") {
        done = opts;
        opts = {};
      }
      const self = this;
      done =
        done ||
        function defaultRenderCallback(err, html) {
          if (err) return req.next(err);
          self.send(html);
        };
      const renderStart = nowNs();
      return originalRender.call(this, view, opts, function timedRenderCallback(err, html) {
        try {
          store.renderMs += msBetween(renderStart, nowNs());
          store.renderCount += 1;
        } catch {
          // measurement only
        }
        done(err, html);
      });
    };

    const finalize = () => {
      if (store.finished) return;
      store.finished = true;
      try {
        record(req, res, store, nowNs(), !res.writableFinished);
      } catch (err) {
        console.error("[requestTiming] record failed:", err.message);
      }
    };
    res.once("finish", finalize);
    res.once("close", finalize);
  } catch (err) {
    console.error("[requestTiming] setup failed:", err.message);
    return next();
  }

  als.run(store, next);
}

// --- Flushing -----------------------------------------------------------------------------------
let flushing = false;
let failing = false;

async function flushNow() {
  if (flushing) return;
  if (!hourlyBuffer.size && !slowBuffer.length) return;
  flushing = true;
  const hourlyRows = [...hourlyBuffer.values()];
  const slowRows = slowBuffer;
  hourlyBuffer = new Map();
  slowBuffer = [];
  try {
    await requestTimingRepo.flush(hourlyRows, slowRows);
    if (failing) console.log("[requestTiming] flush recovered");
    failing = false;
  } catch (err) {
    // One line per failure streak, not one per tick: an outage would otherwise log every 15s.
    if (!failing) console.error("[requestTiming] flush failed, dropping this batch:", err.message);
    failing = true;
  } finally {
    flushing = false;
  }
}

// Started at require time, from app.js's top level, on purpose: a timer inherits the async
// context it was created in, and one created lazily inside a request would attribute every later
// flush's Mongo writes to that request.
const flushTimer = setInterval(() => {
  flushNow().catch(() => {});
}, FLUSH_INTERVAL_MS);
flushTimer.unref();

module.exports = requestTiming;
module.exports.flushNow = flushNow;
