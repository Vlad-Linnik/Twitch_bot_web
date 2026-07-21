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
// 5, not a group of 3 plus a separate group of 3 sharing a cell. Also keeps
// each group's contributing runs (not just its flattened cells) so
// classifyGroupShape below can tell a plain 4-in-a-row from a T/Г crossing -
// see findMatchGroups.
function findMatchGroups(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const matched = make2d(rows, cols, false);
  const runs = [];

  for (let r = 0; r < rows; r++) {
    let runStart = 0;
    for (let c = 1; c <= cols; c++) {
      const sameAsRunStart = c < cols && grid[r][c] !== null && grid[r][c] === grid[r][runStart];
      if (sameAsRunStart) continue;
      if (c - runStart >= 3 && grid[r][runStart] !== null) {
        const cells = [];
        for (let cc = runStart; cc < c; cc++) {
          matched[r][cc] = true;
          cells.push([r, cc]);
        }
        runs.push({ orientation: "h", cells });
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
        const cells = [];
        for (let rr = runStart; rr < r; rr++) {
          matched[rr][c] = true;
          cells.push([rr, c]);
        }
        runs.push({ orientation: "v", cells });
      }
      runStart = r;
    }
  }

  const seen = make2d(rows, cols, false);
  const groupIdAt = make2d(rows, cols, -1);
  const groups = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!matched[r][c] || seen[r][c]) continue;
      const cells = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      const groupId = groups.length;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        cells.push([cr, cc]);
        groupIdAt[cr][cc] = groupId;
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
      groups.push({ cells, runs: [] });
    }
  }

  // Every cell of a run is mutually reachable along the run itself, so all of
  // a run's cells always land in the same flood-filled group - look up that
  // group via the run's first cell.
  for (const run of runs) {
    const [r0, c0] = run.cells[0];
    groups[groupIdAt[r0][c0]].runs.push(run);
  }

  return groups;
}

function findMatches(grid) {
  return findMatchGroups(grid).map((g) => g.cells);
}

function dedupeCellList(cellArrays) {
  const seen = new Set();
  const out = [];
  for (const cells of cellArrays) {
    for (const [r, c] of cells) {
      const key = r + "," + c;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([r, c]);
      }
    }
  }
  return out;
}

function isRunEndpoint(run, cell) {
  const first = run.cells[0];
  const last = run.cells[run.cells.length - 1];
  return (cell[0] === first[0] && cell[1] === first[1]) || (cell[0] === last[0] && cell[1] === last[1]);
}

// Classifies a matched group's shape to decide whether it triggers a bonus
// blast alongside its normal clear:
// - A single straight run of 4+ (no intersection) blasts the opposite line -
//   a horizontal run clears its middle cell's column, a vertical run clears
//   its middle cell's row (matches "4 в ряд -> взрыв столбика", "4 в
//   столбик -> взрыв ряда").
// - Two perpendicular runs of 3+ crossing at exactly one cell: if that cell
//   is an endpoint of BOTH runs (a right-angle corner, like the letter "Г")
//   it blasts a 3x3 area around the corner; otherwise (the crossing sits in
//   the middle of at least one run, like the letter "Т") it blasts every
//   crystal of that type on the board.
// - Anything else (3+ runs, or two same-orientation runs that only ended up
//   in the same group via incidental cell-adjacency rather than a shared
//   run cell) gets no bonus - just the plain match.
function classifyGroupShape(group, grid) {
  const runs = group.runs;
  if (runs.length === 1) {
    const run = runs[0];
    if (run.cells.length < 4) return null;
    const mid = run.cells[Math.floor(run.cells.length / 2)];
    return run.orientation === "h"
      ? { kind: "clearColumn", r: mid[0], c: mid[1] }
      : { kind: "clearRow", r: mid[0], c: mid[1] };
  }
  if (runs.length === 2) {
    const [a, b] = runs;
    if (a.orientation === b.orientation) return null;
    const aCells = new Set(a.cells.map(([r, c]) => r + "," + c));
    const shared = b.cells.find(([r, c]) => aCells.has(r + "," + c));
    if (!shared) return null;
    if (isRunEndpoint(a, shared) && isRunEndpoint(b, shared)) {
      return { kind: "clearArea", r: shared[0], c: shared[1] };
    }
    return { kind: "clearType", type: grid[shared[0]][shared[1]] };
  }
  return null;
}

// Area blast radius: 2 -> a 5x5 square (radius = (side-1)/2) around the
// corner cell.
const AREA_BLAST_RADIUS = 2;

function cellsForShape(grid, shape) {
  if (shape.kind === "clearColumn") return getColCells(grid, shape.c);
  if (shape.kind === "clearRow") return getRowCells(grid, shape.r);
  if (shape.kind === "clearArea") return getAreaCells(grid, shape.r, shape.c, AREA_BLAST_RADIUS);
  return getTypeCells(grid, shape.type);
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

// Runs match -> clear -> gravity -> refill until the grid stabilizes, same
// as before, except each step's groups are now run through
// classifyGroupShape first: a group with a bonus shape has its clear set
// widened to the whole column/row/area/type before the clear (see
// cellsForShape) - so a shape bonus fires automatically, in the same visual
// step, with no separate "cast an ability" step of its own. `specials`
// records which shape(s) fired that step, for match3.js's combo callout.
function resolveCascade(grid, typeCount, rng) {
  const random = rng || Math.random;
  const steps = [];
  let totalCleared = 0;
  while (steps.length < MAX_CASCADE_STEPS) {
    const groups = findMatchGroups(grid);
    if (groups.length === 0) break;

    const expanded = groups.map((group) => {
      const shape = classifyGroupShape(group, grid);
      if (!shape) return { cells: group.cells, special: null };
      return { cells: dedupeCellList([group.cells, cellsForShape(grid, shape)]), special: shape.kind };
    });

    const clearedCells = [];
    for (const { cells } of expanded) {
      for (const [r, c] of cells) {
        if (grid[r][c] === null) continue; // already cleared by an overlapping group this same step
        grid[r][c] = null;
        clearedCells.push([r, c]);
      }
    }
    const moves = applyGravity(grid);
    const newCells = refillGrid(grid, typeCount, random);
    totalCleared += clearedCells.length;
    steps.push({
      clearedCount: clearedCells.length,
      groupSizes: expanded.map((g) => g.cells.length),
      specials: expanded.map((g) => g.special).filter(Boolean),
      clearedCells,
      moves,
      newCells,
      gridAfter: grid.map((row) => row.slice()),
    });
  }
  return { steps, totalCleared };
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
  findMatchGroups,
  classifyGroupShape,
  applyGravity,
  refillGrid,
  resolveCascade,
  getRowCells,
  getColCells,
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
