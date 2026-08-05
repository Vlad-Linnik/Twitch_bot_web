// Server-side replay driver for /games/2048.
//
// The simplest of the six to verify: 2048 is fully deterministic given a seed
// and a direction sequence, and it is all integer arithmetic, so there is no
// floating-point divergence risk between the server's V8 and a player's
// browser. The client and this driver run the SAME engine
// (public/js/games/engines/game2048Engine.js), so there is only one
// implementation of the merge rules to be right.
//
// The one thing that must match exactly is the RNG stream: a move that changes
// nothing spawns no tile and therefore draws nothing. Spawning on a no-op -
// or skipping a spawn after a real move - shifts every subsequent draw and
// silently rewrites the rest of the game.
"use strict";

const engine = require("../../public/js/games/engines/game2048Engine");
const codec = require("../../public/js/games/engines/replayCodec");

// Bump together with RULES_VERSION in public/js/games/2048.js whenever a
// gameplay constant changes. A replay recorded under a different version is
// not replayed at all - a deploy landing mid-run must never cost a player
// their score.
const RULES_VERSION = 1;

// Direction lives in the opcode byte itself, no argument bytes - 2 bytes per
// event, which is what keeps a 20000-move marathon inside its payload ceiling.
const DIRECTIONS = ["left", "right", "up", "down"];

function replay(events, seed, ctx) {
  const rng = codec.mulberry32(seed);
  const state = engine.createState(rng);
  let moves = 0;

  for (let i = 0; i < events.length; i++) {
    // A wall-clock guard, not a rules guard: blowing the budget degrades the
    // submission to unverified rather than failing the player.
    if ((i & 511) === 0 && ctx.deadlineExceeded()) break;

    const ev = events[i];
    const dir = DIRECTIONS[ev.opcode];
    if (!dir) return { structuralError: "unknown direction opcode: " + ev.opcode };

    // A null result is a legal no-op (the player pressed into a wall). The
    // client doesn't record those - it returns before recording - but a
    // harmless one must never be treated as an error.
    if (engine.move(state, dir, rng)) moves++;

    if (engine.isGameOver(state)) break;
  }

  return {
    score: state.score,
    simMs: ctx.totalDurationMs || (events.length ? events[events.length - 1].at : 0),
    detail: { moves, won: engine.hasReachedWinValue(state), over: engine.isGameOver(state) },
  };
}

module.exports = {
  gameKey: "2048",
  rulesVersion: RULES_VERSION,
  DIRECTIONS,
  replay,
};
