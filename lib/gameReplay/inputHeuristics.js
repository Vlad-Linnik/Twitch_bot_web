// Cheap statistical tests over a replay's input timing, looking for a script
// playing the real game rather than a human. Run inside the replay budget, O(n)
// over the event list.
//
// THESE NEVER REJECT. They append a reason to the run's flag document and a
// human decides on /admin/game-runs. That policy is not a nicety - it's what
// makes the false-positive rate a matter of an admin's attention rather than a
// player's record.
//
// FALSE POSITIVES ARE THE DESIGN CONSTRAINT HERE. Every test below is written
// against a specific way an honest player trips a naive version of it:
//
//  * OS key auto-repeat. Holding ArrowLeft emits a metronomic ~33ms stream.
//    Any cadence/jitter/rate test run over raw events flags every player who
//    holds a key. Handled by ignoring `synthetic` events entirely (the client
//    marks auto-repeat and drag-derived events - see replayCodec.js's action
//    byte), so all four tests see only discrete, deliberate human actions.
//
//  * Drag gestures. Falling Blocks turns one pointer move into several
//    engine moves in a single tick, i.e. a burst at dt=0. Same fix: those are
//    recorded synthetic.
//
//  * Timer coarsening. Firefox with privacy.resistFingerprinting, and Tor
//    Browser, round performance.now() to 100ms. A "most dts are round numbers"
//    test therefore flags a whole class of privacy-conscious users and tells
//    you nothing about scripting. Deliberately NOT implemented - see the plan's
//    false-positive analysis.
//
//  * Reaction-time tests. Games like Pipe Dodger show you the obstacle seconds
//    ahead; a human plans rather than reacts, so "acted within 80ms of the
//    stimulus" is not evidence of anything. Also deliberately not implemented.
"use strict";

// One object so tuning is a one-line change once real traffic has been
// observed. Everything starts deliberately conservative: it is far better to
// miss a bot in week one than to bury the review queue in honest players.
const THRESHOLDS = {
  // Below this many discrete events, timing distributions are meaningless.
  minEvents: 40,
  minEventsForJitter: 100,
  // Share of events landing on the single most common 1ms-rounded interval.
  constantCadenceShare: 0.6,
  // Coefficient of variation (stdev/mean). Human play sits around 0.35-1.2;
  // 0.08 is far below anything a hand produces, even on a rhythmic game.
  lowJitterCv: 0.08,
  // Sliding-window ceiling on deliberate (non-repeat) actions.
  apmWindowMs: 10000,
  apmMaxEvents: 180,
  // Per-game override where the game's own pace makes the generic ceiling
  // meaningless - flapping more than ~6/s in Pipe Dodger is not a thing.
  apmMaxEventsByGame: { "pipe-dodger": 60 },
};

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Only discrete, deliberate actions - see the module comment.
function realIntervals(events) {
  const out = [];
  let lastAt = null;
  for (const ev of events) {
    if (ev.synthetic) continue;
    if (lastAt !== null) out.push(ev.at - lastAt);
    lastAt = ev.at;
  }
  return out;
}

function checkConstantCadence(intervals) {
  if (intervals.length < THRESHOLDS.minEvents) return null;
  const counts = new Map();
  let best = 0;
  let bestValue = null;
  for (const dt of intervals) {
    const key = Math.round(dt);
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    if (next > best) {
      best = next;
      bestValue = key;
    }
  }
  const share = best / intervals.length;
  if (share < THRESHOLDS.constantCadenceShare) return null;
  return {
    code: "constantCadence",
    detail: { intervalMs: bestValue, share: Number(share.toFixed(3)), samples: intervals.length },
  };
}

function checkLowJitter(intervals) {
  // Bound the window: sub-5ms entries are burst artifacts and multi-second
  // gaps are the player thinking, neither says anything about jitter.
  const usable = intervals.filter((dt) => dt >= 5 && dt <= 2000);
  if (usable.length < THRESHOLDS.minEventsForJitter) return null;
  const avg = mean(usable);
  if (avg <= 0) return null;
  let variance = 0;
  for (const dt of usable) variance += (dt - avg) * (dt - avg);
  const cv = Math.sqrt(variance / usable.length) / avg;
  if (cv >= THRESHOLDS.lowJitterCv) return null;
  return {
    code: "lowJitter",
    detail: { cv: Number(cv.toFixed(4)), meanMs: Math.round(avg), samples: usable.length },
  };
}

function checkSuperhumanApm(events, gameKey) {
  const times = [];
  for (const ev of events) {
    if (!ev.synthetic) times.push(ev.at);
  }
  if (times.length < THRESHOLDS.minEvents) return null;
  const max = THRESHOLDS.apmMaxEventsByGame[gameKey] ?? THRESHOLDS.apmMaxEvents;

  // Sliding window over an already time-ordered list.
  let start = 0;
  let peak = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > THRESHOLDS.apmWindowMs) start++;
    peak = Math.max(peak, end - start + 1);
  }
  if (peak <= max) return null;
  return {
    code: "superhumanApm",
    detail: { peak, windowMs: THRESHOLDS.apmWindowMs, limit: max },
  };
}

// Returns [{code, detail}] - empty for an ordinary human run.
function analyze(events, gameKey) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const intervals = realIntervals(events);
  const reasons = [];
  const cadence = checkConstantCadence(intervals);
  if (cadence) reasons.push(cadence);
  const jitter = checkLowJitter(intervals);
  if (jitter) reasons.push(jitter);
  const apm = checkSuperhumanApm(events, gameKey);
  if (apm) reasons.push(apm);
  return reasons;
}

module.exports = { THRESHOLDS, analyze, realIntervals };
