// Server-side replay driver for /games/minesweeper - THE REFERENCE
// IMPLEMENTATION. The other five drivers follow this shape; read this one
// first.
//
// Re-runs a recorded run against the same pure engine the browser used
// (public/js/games/engines/minesweeperEngine.js, unchanged - it already takes
// an injectable rng) seeded with the SERVER's own seed, and returns the number
// of boards actually cleared. The client's claimed score never enters into it.
//
// Four things have to match public/js/games/minesweeper.js exactly, or the
// RNG streams diverge and an honest player gets a wrong score:
//
//  1. ONE rng for the whole run, not one per board. generateBoard consumes 72
//     or 73 draws depending on whether a bonus cell lands, so the count is
//     data-dependent and only a continuous stream stays in step.
//
//  2. Board generation is deferred to each board's first REVEAL event, using
//     THAT event's own cell as the safe cell - not the board's center. A
//     fresh board deals as an un-mined shell (engine.createShell) so it can
//     be displayed and flagged before the player's first click; the RNG draw
//     for engine.generateBoard only happens once that first reveal lands,
//     with the clicked cell threaded through as safeRow/safeCol. Any flags
//     placed on the shell beforehand are carried onto the generated board.
//
//  3. The deferred board swap. The client schedules nextBoard() 400ms after a
//     mine (:250) and 250ms after a clear (:265), so there is a dead window
//     during which clicks still land on the OLD board. Swapping in the next
//     board's shell immediately here would let a click during that window
//     wrongly trigger the NEXT board's generation ahead of the client.
//
//  4. The deadline grows during the run. A bonus cell adds 10s, capped at 6
//     procs, so the cutoff cannot be computed up front.
"use strict";

const engine = require("../../public/js/games/engines/minesweeperEngine");
const codec = require("../../public/js/games/engines/replayCodec");

// Bump whenever a gameplay constant below changes. A replay recorded under a
// different version is not replayed at all - a deploy landing mid-run must
// never cost a player their score.
const RULES_VERSION = 2;

// KEEP IN SYNC WITH public/js/games/minesweeper.js (:22-25, :248, :264)
const RUN_MS = 5 * 60 * 1000;
const BONUS_MS = 10 * 1000;
const BONUS_MAX_PROCS = 6;
const DIFFICULTY_KEY = "beginner";
const SWAP_AFTER_EXPLODE_MS = 400;
const SWAP_AFTER_CLEAR_MS = 250;

const OP_REVEAL = 0;
const OP_FLAG = 1;

function replay(events, seed, ctx) {
  const rng = codec.mulberry32(seed);
  const diff = engine.DIFFICULTIES[DIFFICULTY_KEY];
  const cells = diff.rows * diff.cols;

  let board = engine.createShell(DIFFICULTY_KEY); // startRun() deals an empty shell at t=0; the real board waits for the first reveal
  let boardsCleared = 0;
  let bonusProcs = 0;
  let deadline = RUN_MS;
  // Timestamp of the pending deferred nextBoard(), or null. Mirrors the
  // client's `boardDone` flag: a finished board stops accepting input until
  // the swap lands, so at most one swap is ever outstanding.
  let pendingSwapAt = null;

  function applyDueSwap(now) {
    if (pendingSwapAt === null || pendingSwapAt > now) return;
    pendingSwapAt = null;
    board = engine.createShell(DIFFICULTY_KEY);
  }

  for (let i = 0; i < events.length; i++) {
    // The replay budget is a wall-clock guard, not a rules guard: exceeding it
    // degrades the submission to unverified rather than failing the player.
    if ((i & 511) === 0 && ctx.deadlineExceeded()) break;

    const ev = events[i];
    // The run ended on the clock; anything logged after it never happened.
    if (ev.at > deadline) break;

    applyDueSwap(ev.at);
    // A finished board is inert until the swap lands (client: `boardDone`).
    // The client doesn't record such clicks at all, so this is defensive -
    // ignore rather than reject, since refusing would turn a stray click into
    // a lost run.
    if (pendingSwapAt !== null) continue;

    const cell = ev.a;
    if (!Number.isInteger(cell) || cell < 0 || cell >= cells) {
      return { structuralError: "cell out of range: " + cell };
    }
    const r = Math.floor(cell / diff.cols);
    const c = cell % diff.cols;

    if (ev.opcode === OP_FLAG) {
      // Flags never touch the RNG or the score, but they gate chording, so
      // they have to be replayed.
      engine.toggleFlag(board, r, c);
      continue;
    }
    if (ev.opcode !== OP_REVEAL) {
      return { structuralError: "unknown opcode: " + ev.opcode };
    }

    // Mirrors handleReveal: the board's first reveal deals it for real, using
    // THIS cell as the safe cell, carrying over any flags placed on the
    // shell beforehand.
    if (!board.generated) {
      const flagged = board.flagged;
      board = engine.generateBoard(DIFFICULTY_KEY, r, c, rng);
      board.flagged = flagged;
    }
    // Mirrors handleReveal (:224-259): a click on an already-revealed cell
    // chords, anything else reveals.
    const result = board.revealed[r][c] ? engine.chordCell(board, r, c) : engine.revealCell(board, r, c);

    if (result.exploded) {
      pendingSwapAt = ev.at + SWAP_AFTER_EXPLODE_MS;
      continue;
    }
    if (result.bonus && bonusProcs < BONUS_MAX_PROCS) {
      bonusProcs++;
      deadline += BONUS_MS;
    }
    if (engine.checkWin(board)) {
      boardsCleared++;
      pendingSwapAt = ev.at + SWAP_AFTER_CLEAR_MS;
    }
  }

  return {
    score: boardsCleared,
    // The run is over at the deadline no matter when the last click landed.
    simMs: Math.min(deadline, Math.max(ctx.totalDurationMs || 0, events.length ? events[events.length - 1].at : 0)),
    detail: { boardsCleared, bonusProcs, deadline },
  };
}

module.exports = {
  gameKey: "minesweeper",
  rulesVersion: RULES_VERSION,
  RUN_MS,
  BONUS_MS,
  BONUS_MAX_PROCS,
  OP_REVEAL,
  OP_FLAG,
  replay,
};
