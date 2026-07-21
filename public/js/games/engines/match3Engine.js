// Pure, I/O-free Match-3 grid logic - same "pure engine + bespoke game-loop
// caller" split as engines/minesweeperEngine.js right next to this file (see
// that file's header comment for why this lives under public/js/games/
// engines/ instead of lib/: no JS bundler in this repo, so lib/ never reaches
// the browser, but this file needs to run client-side AND be unit-tested
// under node:test).
"use strict";

const BASE_POINTS = 10;
// Cascade-step multiplier: step 1 (the swap's own match) is unmultiplied,
// each further gravity-triggered step within the same cascade is worth more,
// capped at step 5+ so a very long lucky cascade doesn't blow up unbounded.
const STEP_MULTIPLIERS = [1, 1.5, 2, 3, 4];

function stepMultiplier(stepIndex) {
  const idx = Math.min(stepIndex, STEP_MULTIPLIERS.length) - 1;
  return STEP_MULTIPLIERS[idx];
}

// A bigger simultaneous match is worth more per crystal, not just more in
// total - a 5-crystal match is more than "5/3 as good" as a 3-crystal one.
function groupSizeMultiplier(size) {
  if (size >= 5) return 2;
  if (size === 4) return 1.5;
  return 1;
}

function make2d(rows, cols, fill) {
  return Array.from({ length: rows }, () => new Array(cols).fill(fill));
}

function wouldMatchAt(grid, r, c, type) {
  // Would placing `type` at (r,c) complete a horizontal or vertical run of 3?
  // Only ever needs to look left/up since the grid is filled row-major.
  if (c >= 2 && grid[r][c - 1] === type && grid[r][c - 2] === type) return true;
  if (r >= 2 && grid[r - 1][c] === type && grid[r - 2][c] === type) return true;
  return false;
}

// Fills every cell left-to-right, top-to-bottom, rejecting any type that
// would complete an immediate 3-in-a-row/column - so a freshly generated grid
// never starts with a match already sitting on it.
function generateGrid(rows, cols, typeCount, rng) {
  const random = rng || Math.random;
  const grid = make2d(rows, cols, null);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let type;
      let attempts = 0;
      do {
        type = Math.floor(random() * typeCount);
        attempts++;
      } while (wouldMatchAt(grid, r, c, type) && attempts < typeCount * 4);
      grid[r][c] = type;
    }
  }
  return grid;
}

function isAdjacent(a, b) {
  return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}

function swapCells(grid, a, b) {
  const tmp = grid[a.r][a.c];
  grid[a.r][a.c] = grid[b.r][b.c];
  grid[b.r][b.c] = tmp;
}

// Horizontal/vertical runs of 3+ identical, non-null values, with runs that
// touch (an L or T intersection) merged into a single group via a flood fill
// over the matched cells - a T-shaped 5-crystal match scores as one group of
// 5, not a group of 3 plus a separate group of 3 sharing a cell.
function findMatches(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const matched = make2d(rows, cols, false);

  for (let r = 0; r < rows; r++) {
    let runStart = 0;
    for (let c = 1; c <= cols; c++) {
      const sameAsRunStart = c < cols && grid[r][c] !== null && grid[r][c] === grid[r][runStart];
      if (sameAsRunStart) continue;
      if (c - runStart >= 3 && grid[r][runStart] !== null) {
        for (let cc = runStart; cc < c; cc++) matched[r][cc] = true;
      }
      runStart = c;
    }
  }

  for (let c = 0; c < cols; c++) {
    let runStart = 0;
    for (let r = 1; r <= rows; r++) {
      const sameAsRunStart = r < rows && grid[r][c] !== null && grid[r][c] === grid[runStart][c];
      if (sameAsRunStart) continue;
      if (r - runStart >= 3 && grid[runStart][c] !== null) {
        for (let rr = runStart; rr < r; rr++) matched[rr][c] = true;
      }
      runStart = r;
    }
  }

  const seen = make2d(rows, cols, false);
  const groups = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!matched[r][c] || seen[r][c]) continue;
      const cells = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        cells.push([cr, cc]);
        const neighbors = [
          [cr - 1, cc],
          [cr + 1, cc],
          [cr, cc - 1],
          [cr, cc + 1],
        ];
        for (const [nr, nc] of neighbors) {
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && matched[nr][nc] && !seen[nr][nc]) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      groups.push(cells);
    }
  }
  return groups;
}

// Adjacency + "does the swap actually create a match" check - the standard
// Match-3 legal-move rule (an adjacent swap that doesn't produce any match is
// rejected and reverted by the caller). Mutates then reverts `grid` as a
// scratch check; never leaves it changed.
function isValidSwap(grid, a, b) {
  if (!isAdjacent(a, b)) return false;
  swapCells(grid, a, b);
  const hasMatch = findMatches(grid).length > 0;
  swapCells(grid, a, b);
  return hasMatch;
}

// Returns the list of {c, fromRow, toRow} moves it made (only entries that
// actually changed row - a crystal already resting at its post-compaction
// row isn't a "move"), so a caller can animate the drop instead of just
// reading the final grid. Compaction order (bottom-up per column) guarantees
// every row ends up in exactly one of three buckets: untouched, the
// destination of one of these moves, or refilled by refillGrid below - see
// match3.js's animateCascadeSteps for how that invariant is used.
function applyGravity(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const moves = [];
  for (let c = 0; c < cols; c++) {
    let write = rows - 1;
    for (let r = rows - 1; r >= 0; r--) {
      if (grid[r][c] !== null) {
        if (write !== r) {
          grid[write][c] = grid[r][c];
          grid[r][c] = null;
          moves.push({ c, fromRow: r, toRow: write });
        }
        write--;
      }
    }
    for (let r = write; r >= 0; r--) grid[r][c] = null;
  }
  return moves;
}

// Returns the {r, c} of every cell it filled, in the same row-major order it
// visited them (top-to-bottom within a column), so a caller can animate new
// crystals falling in from above stacked in that same order.
function refillGrid(grid, typeCount, rng) {
  const random = rng || Math.random;
  const rows = grid.length;
  const cols = grid[0].length;
  const newCells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === null) {
        grid[r][c] = Math.floor(random() * typeCount);
        newCells.push({ r, c });
      }
    }
  }
  return newCells;
}

// Runs match -> clear -> gravity -> refill until the grid stabilizes (no more
// matches), mutating `grid` in place. Returns each step's cleared group sizes
// so the caller (or computeCascadeScore below) can score the whole cascade,
// rewarding longer chains and bigger simultaneous groups - plus, for each
// step, enough to animate it after the fact even though this function
// resolves the whole cascade synchronously in one call: `clearedCells` (the
// matched positions, still holding their pre-clear values in whatever the
// caller rendered before this call/step), `moves`/`newCells` from
// applyGravity/refillGrid above, and `gridAfter`, a snapshot of the grid once
// this step's gravity+refill settles (the source of truth for what a move's
// or new cell's landing sprite should be). See match3.js's
// animateCascadeSteps.
// Defensive cap - a real refill (Math.random, typeCount >= 4-5) essentially
// never keeps re-matching forever, but nothing about the loop's own logic
// rules it out (a pathological/misbehaving rng could regenerate the same
// pattern every refill), so this bounds the worst case instead of hanging the
// whole game loop.
const MAX_CASCADE_STEPS = 50;

// Shared loop behind resolveCascade/resolveAbilityClear below: clear a step's
// groups, gravity+refill, record the step, then keep re-scanning the grid for
// further matches until it stabilizes. `firstGroups`, when given, is used
// verbatim for step 1 instead of a findMatches() scan - that's what lets an
// ability's arbitrary cell selection (a whole row, an area, every crystal of
// one type) go through the exact same clear/animate/score pipeline as a
// regular match, cascades included.
function resolveFromGroups(grid, typeCount, rng, firstGroups) {
  const random = rng || Math.random;
  const steps = [];
  let totalCleared = 0;
  let groups = firstGroups;
  while (steps.length < MAX_CASCADE_STEPS) {
    if (groups === undefined) groups = findMatches(grid);
    if (!groups || groups.length === 0) break;
    let clearedCount = 0;
    const clearedCells = [];
    for (const group of groups) {
      for (const [r, c] of group) {
        grid[r][c] = null;
        clearedCells.push([r, c]);
      }
      clearedCount += group.length;
    }
    totalCleared += clearedCount;
    const moves = applyGravity(grid);
    const newCells = refillGrid(grid, typeCount, random);
    steps.push({
      clearedCount,
      groupSizes: groups.map((g) => g.length),
      clearedCells,
      moves,
      newCells,
      gridAfter: grid.map((row) => row.slice()),
    });
    groups = undefined; // every step after the first always comes from a fresh scan
  }
  return { steps, totalCleared };
}

function resolveCascade(grid, typeCount, rng) {
  return resolveFromGroups(grid, typeCount, rng, undefined);
}

// Clears an arbitrary, caller-chosen set of cells as a single group (an
// ability blast rather than a matched run), then lets any gravity-exposed
// matches cascade normally - same clear/animate/score pipeline as a regular
// swap via resolveCascade above, just seeded with a hand-picked first group
// instead of one findMatches() finds on its own.
function resolveAbilityClear(grid, cells, typeCount, rng) {
  return resolveFromGroups(grid, typeCount, rng, [cells]);
}

function getRowCells(grid, r) {
  const cols = grid[0].length;
  const cells = [];
  for (let c = 0; c < cols; c++) cells.push([r, c]);
  return cells;
}

function getColCells(grid, c) {
  const rows = grid.length;
  const cells = [];
  for (let r = 0; r < rows; r++) cells.push([r, c]);
  return cells;
}

// The "line" ability's target set: the tapped cell's full row AND column
// (a cross/plus shape) in one blast, deduped so the shared cell isn't
// double-counted into groupSizes.
function getCrossCells(grid, r, c) {
  const seen = new Set();
  const cells = [];
  for (const cell of getRowCells(grid, r).concat(getColCells(grid, c))) {
    const key = cell[0] + "," + cell[1];
    if (!seen.has(key)) {
      seen.add(key);
      cells.push(cell);
    }
  }
  return cells;
}

// The "area" ability's target set: a (2*radius+1)-side square centered on
// the tapped cell, clipped at the board edges (radius 1 = 3x3 = 9 cells).
function getAreaCells(grid, r, c, radius) {
  const rows = grid.length;
  const cols = grid[0].length;
  const cells = [];
  for (let rr = r - radius; rr <= r + radius; rr++) {
    for (let cc = c - radius; cc <= c + radius; cc++) {
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) cells.push([rr, cc]);
    }
  }
  return cells;
}

// The "type" ability's target set: every crystal on the board matching the
// tapped cell's type.
function getTypeCells(grid, type) {
  const rows = grid.length;
  const cols = grid[0].length;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === type) cells.push([r, c]);
    }
  }
  return cells;
}

// Points for one resolveCascade() result - see this module's header comment
// for the multiplier design (also documented in the implementation plan).
function computeCascadeScore(steps) {
  let total = 0;
  steps.forEach((step, i) => {
    const sm = stepMultiplier(i + 1);
    for (const groupSize of step.groupSizes) {
      total += BASE_POINTS * groupSize * groupSizeMultiplier(groupSize) * sm;
    }
  });
  return Math.round(total);
}

function hasAnyLegalMove(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && isValidSwap(grid, { r, c }, { r, c: c + 1 })) return true;
      if (r + 1 < rows && isValidSwap(grid, { r, c }, { r: r + 1, c })) return true;
    }
  }
  return false;
}

const api = {
  BASE_POINTS,
  generateGrid,
  isAdjacent,
  swapCells,
  isValidSwap,
  findMatches,
  applyGravity,
  refillGrid,
  resolveCascade,
  resolveAbilityClear,
  getRowCells,
  getColCells,
  getCrossCells,
  getAreaCells,
  getTypeCells,
  computeCascadeScore,
  hasAnyLegalMove,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.Match3Engine = api;
}
