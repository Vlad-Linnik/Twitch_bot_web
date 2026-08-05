// Server-side replay driver for /games/falling-blocks - the hardest of the six.
//
// Two things make this one work at all, both fixed in the engine
// (public/js/games/engines/fallingBlocksEngine.js): the drop interval is a
// precomputed table rather than Math.pow (not correctly-rounded in ECMAScript,
// so the server and a player's Firefox could differ in the last ULP and
// desync a whole marathon), and gravity is a proper accumulator on a fixed
// timestep rather than whatever delta the browser happened to deliver.
//
// Like pipe-dodger, event timestamps are SIMULATION time, not wall time. The
// client only advances its simulation while the game is actually running, so a
// paused game - and this game auto-pauses on blur - simply stops the clock.
// That's why no pause/resume opcodes are needed: a pause is just a gap that
// never happened as far as the simulation is concerned. The wall-clock check in
// index.js is one-directional precisely to tolerate this.
"use strict";

const engine = require("../../public/js/games/engines/fallingBlocksEngine");
const codec = require("../../public/js/games/engines/replayCodec");

// Bump together with RULES_VERSION in public/js/games/falling-blocks.js.
const RULES_VERSION = 1;

// At 16ms a step, this is ~40 minutes of simulated play - beyond any real
// marathon, and it bounds the work a forged replay can buy with a tiny payload.
const MAX_STEPS = 150000;

function replay(events, seed, ctx) {
  const state = engine.createState(codec.mulberry32(seed));
  let simMs = 0;
  let steps = 0;
  let budgetHit = false;

  // The identical loop the client runs, which is what keeps the two in step.
  function advanceTo(target) {
    while (!state.over && simMs + engine.FIXED_DT_MS <= target) {
      if (steps >= MAX_STEPS) return;
      // Checked on step count rather than event index: a marathon is a great
      // many gravity steps between relatively few keypresses.
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
    advanceTo(ev.at);
    if (budgetHit || state.over) break;
    // A `synthetic` event is an OS key auto-repeat or one step of a drag
    // gesture - real input as far as the RULES are concerned, and replayed
    // identically. The flag only tells the bot-detection heuristics to leave
    // it out of their timing analysis (lib/gameReplay/inputHeuristics.js).
    const result = engine.applyInput(state, ev.opcode);
    if (result === null) return { structuralError: "unknown opcode: " + ev.opcode };
  }

  // Play out the tail: gravity usually tops the board out a little after the
  // player's last keypress.
  if (!budgetHit && !state.over) advanceTo(ctx.totalDurationMs || simMs);

  return {
    score: state.score,
    simMs,
    detail: { steps, lines: state.lines, level: state.level, over: state.over },
  };
}

module.exports = {
  gameKey: "falling-blocks",
  rulesVersion: RULES_VERSION,
  MAX_STEPS,
  replay,
};
