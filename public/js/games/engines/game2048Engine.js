// Pure, I/O-free 2048 rules - no DOM, no timers, no tile identities, so it can
// be unit-tested under node:test AND run both client-side (public/js/games/
// 2048.js) and server-side (lib/gameReplay/2048.js) off the same source. Same
// split as minesweeperEngine.js; this repo has no JS bundler, so a file both
// sides need lives under public/js/games/engines/ and exports itself as a
// CommonJS module OR a browser global depending on who loads it.
//
// The engine works on a plain value grid (0 = empty). Tile ids are purely a
// rendering concern, so `move` returns a description of what happened in
// SOURCE COORDINATES and the client maps those back onto its own tile objects
// to animate them. That's what lets both sides share one implementation
// instead of drifting into two - and two implementations of 2048's merge rules
// would eventually disagree, which would show up as honest players being
// flagged for a score mismatch.
//
// Everything here is integer arithmetic on purpose. Nothing transcendental
// (Math.pow/sin/exp are not correctly-rounded in ECMAScript and can differ in
// the last ULP between the server's V8 and a player's Firefox/Safari, which
// would silently desync a replay).
"use strict";

const SIZE = 4;
const WIN_VALUE = 2048;

function emptyCells(grid) {
  const res = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!grid[r][c]) res.push([r, c]);
    }
  }
  return res;
}

// Two rng draws, always in this order: which empty cell, then which value.
// The caller must not reorder them - the server replays the same stream.
function spawnRandomTile(grid, rng) {
  const empties = emptyCells(grid);
  if (empties.length === 0) return null;
  const [r, c] = empties[Math.floor(rng() * empties.length)];
  const value = rng() < 0.9 ? 2 : 4;
  grid[r][c] = value;
  return { r, c, value };
}

// Each line is SIZE [r,c] pairs ordered toward index 0 - the direction tiles
// slide toward for that move.
function linesFor(dir) {
  const lines = [];
  if (dir === "left" || dir === "right") {
    for (let r = 0; r < SIZE; r++) {
      const cols = [0, 1, 2, 3];
      if (dir === "right") cols.reverse();
      lines.push(cols.map((c) => [r, c]));
    }
  } else {
    for (let c = 0; c < SIZE; c++) {
      const rows = [0, 1, 2, 3];
      if (dir === "down") rows.reverse();
      lines.push(rows.map((r) => [r, c]));
    }
  }
  return lines;
}

function emptyGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

function createState(rng) {
  const state = { grid: emptyGrid(), score: 0, won: false };
  spawnRandomTile(state.grid, rng);
  spawnRandomTile(state.grid, rng);
  return state;
}

// Returns null if the move changes nothing (and then NOTHING is drawn from the
// rng - a no-op move must not advance the stream, or the server desyncs on the
// very next spawn). Otherwise mutates `state` and returns:
//   { gained, ops, spawn }
// where ops are, in the order the client should apply them:
//   { type: "move",  from: [r,c], to: [r,c], value }
//   { type: "merge", primary: [r,c], secondary: [r,c], to: [r,c], value }
// `primary` is the tile that survives and becomes `value`; `secondary` slides
// onto the same cell and is then removed.
function move(state, dir, rng) {
  const lines = linesFor(dir);
  const newGrid = emptyGrid();
  const ops = [];
  let gained = 0;
  let moved = false;

  for (const line of lines) {
    const seq = [];
    for (const [r, c] of line) {
      if (state.grid[r][c]) seq.push({ value: state.grid[r][c], r, c });
    }
    let i = 0;
    let slot = 0;
    while (i < seq.length) {
      const [r, c] = line[slot];
      const cur = seq[i];
      if (i + 1 < seq.length && seq[i + 1].value === cur.value) {
        const secondary = seq[i + 1];
        const value = cur.value * 2;
        gained += value;
        ops.push({
          type: "merge",
          primary: [cur.r, cur.c],
          secondary: [secondary.r, secondary.c],
          to: [r, c],
          value,
        });
        newGrid[r][c] = value;
        moved = true;
        i += 2;
      } else {
        if (cur.r !== r || cur.c !== c) moved = true;
        ops.push({ type: "move", from: [cur.r, cur.c], to: [r, c], value: cur.value });
        newGrid[r][c] = cur.value;
        i += 1;
      }
      slot++;
    }
  }

  if (!moved) return null;

  state.grid = newGrid;
  state.score += gained;
  const spawn = spawnRandomTile(state.grid, rng);
  return { gained, ops, spawn };
}

function hasReachedWinValue(state) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.grid[r][c] >= WIN_VALUE) return true;
    }
  }
  return false;
}

function isGameOver(state) {
  if (emptyCells(state.grid).length > 0) return false;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = state.grid[r][c];
      if (c + 1 < SIZE && state.grid[r][c + 1] === v) return false;
      if (r + 1 < SIZE && state.grid[r + 1][c] === v) return false;
    }
  }
  return true;
}

const api = {
  SIZE,
  WIN_VALUE,
  emptyGrid,
  emptyCells,
  linesFor,
  spawnRandomTile,
  createState,
  move,
  hasReachedWinValue,
  isGameOver,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.Game2048Engine = api;
}
