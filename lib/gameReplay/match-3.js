// Server-side replay driver for /games/match-3. Follows the shape of
// ./minesweeper.js, the reference driver - read that one first.
//
// Re-runs a recorded run against the same pure engine the browser used
// (public/js/games/engines/match3Engine.js, unchanged - it already takes an
// injectable rng at every entry point) seeded with the SERVER's own seed, and
// returns the points actually earned. The client's claimed score never enters
// into it.
//
// Match-3's whole game state is the grid plus which cell is currently
// selected, so a single opcode carrying the tapped cell is enough: the
// engine's own isAdjacent/isValidSwap is what decides whether a tap selects,
// swaps, re-selects or is rejected, exactly as it does in the browser. That
// also means the driver naturally refuses an illegal swap the same way the
// client does, without a rule of its own to keep in sync.
//
// Four things have to match public/js/games/match3.js exactly, or the RNG
// streams diverge and an honest player gets a wrong score:
//
//  1. ONE rng for the whole run, never one per grid. generateGrid rejects
//     types that would complete an immediate match, so it consumes a
//     data-dependent number of draws, and resolveCascade's refills consume
//     more - only a continuous stream stays in step.
//
//  2. freshGrid()'s retry loop. generateGrid can produce a grid with no legal
//     move at all; the client re-rolls until one has one, and every rejected
//     attempt still consumed draws. Replicating the loop is what keeps the
//     stream aligned (:197-201 in match3.js).
//
//  3. The tap state machine, including its dead ends. A tap on the already
//     selected cell clears the selection; a tap on a non-adjacent cell moves
//     the selection there rather than clearing it; an adjacent-but-matchless
//     swap leaves NO selection. Those three paths change what the next tap
//     means, so all of them are replayed even though none of them scores.
//
//  4. The post-cascade "no legal moves left" re-roll, which draws a whole new
//     grid off the same stream.
//
// DELIBERATELY NOT replicated: the client's `busy` flag, which swallows taps
// while a swap/cascade animation plays. Coupling the server to SWAP_MS/
// SHATTER_MS/FALL_MS would mean every visual tweak silently breaks replays for
// honest players. The client never records a tap it swallowed, so the events
// simply don't exist; if one somehow arrives anyway it is applied normally.
// The permissive choice cannot cost a legitimate player points.
"use strict";

const engine = require("../../public/js/games/engines/match3Engine");
const codec = require("../../public/js/games/engines/replayCodec");

// Bump whenever a gameplay constant below changes, together with
// RULES_VERSION in public/js/games/match3.js. A replay recorded under a
// different version is not replayed at all - a deploy landing mid-run must
// never cost a player their score.
const RULES_VERSION = 1;

// KEEP IN SYNC WITH public/js/games/match3.js (:23-26, :460)
const ROWS = 8;
const COLS = 8;
const TYPE_COUNT = 6;
const RUN_MS = 3 * 60 * 1000;
// The client polls its own clock on a 250ms interval, so between the nominal
// deadline and the next tick it is still "running" and still accepts (and
// records, and scores) taps. Truncating at exactly RUN_MS would delete a swap
// the player legitimately made and was legitimately paid for, and show up as a
// scoreMismatch - the worst kind of false positive. One tick of grace costs a
// forger nothing: 250ms buys at most one extra swap they could have made anyway.
const TICK_MS = 250;
const DEADLINE_MS = RUN_MS + TICK_MS;

const CELLS = ROWS * COLS;

const OP_TAP = 0;

// Verbatim copy of match3.js's freshGrid() - see note 2 in the header for why
// the retry loop, not just the final grid, has to be reproduced.
function freshGrid(rng) {
  let g = engine.generateGrid(ROWS, COLS, TYPE_COUNT, rng);
  while (!engine.hasAnyLegalMove(g)) g = engine.generateGrid(ROWS, COLS, TYPE_COUNT, rng);
  return g;
}

function replay(events, seed, ctx) {
  const rng = codec.mulberry32(seed);

  let grid = freshGrid(rng); // startRun() deals the first grid at t=0
  let score = 0;
  let selected = null; // {r,c} of the first tap of a two-tap swap
  let swaps = 0;
  let regenerations = 0;

  for (let i = 0; i < events.length; i++) {
    // The replay budget is a wall-clock guard, not a rules guard: exceeding it
    // degrades the submission to unverified rather than failing the player.
    // Polled far more often than minesweeper's 512 because one match-3 tap is
    // much more expensive than one reveal - hasAnyLegalMove alone runs ~128
    // findMatches passes over the whole grid - so a 512-event stride could
    // overshoot the budget by a lot before anyone noticed.
    if ((i & 127) === 0 && ctx.deadlineExceeded()) break;

    const ev = events[i];
    // The run ended on the clock; anything logged after it never happened.
    if (ev.at > DEADLINE_MS) break;

    if (ev.opcode !== OP_TAP) {
      return { structuralError: "unknown opcode: " + ev.opcode };
    }
    const cell = ev.a;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) {
      return { structuralError: "cell out of range: " + cell };
    }
    const r = Math.floor(cell / COLS);
    const c = cell % COLS;

    // ---- mirrors handleTap (match3.js :362-399) --------------------------
    if (!selected) {
      selected = { r, c };
      continue;
    }
    const a = selected;
    const b = { r, c };
    selected = null;
    // Tapping the selected cell again just deselects it.
    if (a.r === b.r && a.c === b.c) continue;
    // A far-away tap isn't a failed swap - it moves the selection there.
    if (!engine.isAdjacent(a, b)) {
      selected = { r, c };
      continue;
    }
    // An adjacent swap that creates no match is refused and reverted by
    // isValidSwap itself (it swaps, tests, swaps back), so the grid - and the
    // rng - are untouched. The client only shakes the two cells. Not a
    // structural error: a player mis-tapping is the single most ordinary thing
    // that happens in this game.
    if (!engine.isValidSwap(grid, a, b)) continue;

    swaps++;
    engine.swapCells(grid, a, b);
    // resolveCascade runs the whole match -> clear -> gravity -> refill chain
    // synchronously here; the client spreads the same already-computed result
    // over an animation, but the engine call and its rng draws are identical.
    const { steps } = engine.resolveCascade(grid, TYPE_COUNT, rng);
    score += engine.computeCascadeScore(steps);
    if (!engine.hasAnyLegalMove(grid)) {
      grid = freshGrid(rng);
      regenerations++;
    }
  }

  return {
    score,
    // The run is over at the deadline no matter when the last tap landed.
    // Note the one place client and server legitimately disagree: a cascade
    // started just before the timer expires is scored here but is still
    // animating (and so unscored) when the client submits. That direction is
    // safe - index.js caps the stored score at what the player claimed and
    // files a low-severity scoreOverrun - which is why it is left alone rather
    // than modelled with animation constants.
    simMs: Math.min(
      DEADLINE_MS,
      Math.max(ctx.totalDurationMs || 0, events.length ? events[events.length - 1].at : 0)
    ),
    detail: { score, swaps, regenerations, taps: events.length },
  };
}

module.exports = {
  gameKey: "match-3",
  rulesVersion: RULES_VERSION,
  ROWS,
  COLS,
  TYPE_COUNT,
  RUN_MS,
  DEADLINE_MS,
  OP_TAP,
  freshGrid,
  replay,
};
