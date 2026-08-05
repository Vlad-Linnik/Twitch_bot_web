// Server-side replay driver for /games/pipe-dodger.
//
// Real-time physics, so the whole thing hinges on the fixed timestep in
// public/js/games/engines/pipeDodgerEngine.js: both sides advance the
// simulation in identical FIXED_DT_MS slices, and a flap takes effect at the
// first step boundary at or after the timestamp it was recorded with.
//
// IMPORTANT: event timestamps are SIMULATION time, not wall time. The client
// clamps how much it will simulate per animation frame (a backgrounded tab
// must not come back to a dead bird), so its simulated clock deliberately
// falls behind the wall clock. Recording in simulation time is what lets the
// server reproduce the run exactly; the wall-clock plausibility check in
// index.js still works, because simulated time can never run FASTER than real
// time.
"use strict";

const engine = require("../../public/js/games/engines/pipeDodgerEngine");
const codec = require("../../public/js/games/engines/replayCodec");

// Bump together with RULES_VERSION in public/js/games/pipe-dodger.js.
const RULES_VERSION = 1;

const OP_FLAP = 0;

// A run cannot be longer than this many simulated steps. At 125Hz that's ~40
// minutes, far beyond any real Pipe Dodger run (the difficulty maxes out by
// score 15), and it bounds the work a forged replay can ask the server to do.
const MAX_STEPS = 300000;

function replay(events, seed, ctx) {
  const state = engine.createState(codec.mulberry32(seed));
  let simMs = 0;
  let steps = 0;
  let budgetHit = false;

  // Advances the simulation to `target` in whole fixed steps - the identical
  // loop the client runs, which is what keeps the two in step.
  function advanceTo(target) {
    while (!state.dead && simMs + engine.FIXED_DT_MS <= target) {
      if (steps >= MAX_STEPS) return;
      // Checked on step count rather than event index: a long run is a great
      // many steps between very few flaps.
      if ((steps & 1023) === 0 && ctx.deadlineExceeded()) {
        budgetHit = true;
        return;
      }
      engine.step(state);
      simMs += engine.FIXED_DT_MS;
      steps++;
    }
  }

  for (const ev of events) {
    if (ev.opcode !== OP_FLAP) return { structuralError: "unknown opcode: " + ev.opcode };
    advanceTo(ev.at);
    if (budgetHit || state.dead) break;
    engine.applyInput(state, "flap");
  }

  // Play out the tail: the bird usually dies a moment after the last flap.
  if (!budgetHit && !state.dead) advanceTo(ctx.totalDurationMs || simMs);

  return {
    score: state.score,
    simMs,
    detail: { steps, dead: state.dead, flaps: events.length },
  };
}

module.exports = {
  gameKey: "pipe-dodger",
  rulesVersion: RULES_VERSION,
  OP_FLAP,
  MAX_STEPS,
  replay,
};
