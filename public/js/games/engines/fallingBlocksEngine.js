// Pure, I/O-free Falling Blocks rules - no canvas, no sound, no particles, so
// it runs under node:test and server-side (lib/gameReplay/falling-blocks.js)
// off the same source the browser uses. Same placement rule as
// minesweeperEngine.js: no bundler here, so a file both sides need lives under
// public/js/games/engines/ and exports itself as a CommonJS module OR a
// browser global.
//
// TWO DETERMINISM FIXES were required to make this replayable, and both are
// small but real changes to how the game behaves:
//
//  1. DROP_INTERVALS replaces Math.pow(0.78, level - 1). Math.pow is NOT
//     correctly-rounded in ECMAScript - V8 (the server), SpiderMonkey and
//     JavaScriptCore may legally differ in the last ULP, and a one-ULP
//     difference in the drop interval desynchronises an entire marathon,
//     costing an honest player their whole run. The table below is that
//     formula evaluated once, to the same values it always produced.
//
//  2. Gravity is a proper accumulator on a fixed timestep. The old loop added
//     whatever delta the browser delivered and then reset the timer to zero,
//     which made the real drop rate depend on frame rate (a 144Hz screen
//     dropped pieces measurably faster than a 30Hz one) and could not be
//     reproduced by anyone. Now every step is exactly FIXED_DT_MS and the
//     remainder carries over.
//
// Nothing here uses Math.pow/sin/exp - see (1) for why. Only + - * / and
// Math.min/max/floor, all exactly specified by IEEE-754.
"use strict";

const COLS = 12;
const ROWS = 20;

const PIECES = [
  { color: "#38bdf8", cells: [[0, 1], [1, 1], [2, 1], [3, 1]], size: 4 }, // line
  { color: "#fbbf24", cells: [[1, 1], [2, 1], [1, 2], [2, 2]], size: 4 }, // square
  { color: "#c084fc", cells: [[1, 0], [0, 1], [1, 1], [2, 1]], size: 3 }, // tee
  { color: "#34d399", cells: [[1, 0], [2, 0], [0, 1], [1, 1]], size: 3 }, // ess
  { color: "#fb7185", cells: [[0, 0], [1, 0], [1, 1], [2, 1]], size: 3 }, // zee
  { color: "#818cf8", cells: [[0, 0], [0, 1], [1, 1], [2, 1]], size: 3 }, // jay
  { color: "#fb923c", cells: [[2, 0], [0, 1], [1, 1], [2, 1]], size: 3 }, // ell
];

const LINE_SCORES = [0, 100, 300, 500, 800];

// Math.max(70, 1000 * 0.78^(level-1)) precomputed - see (1) above. Level 12
// and beyond all sit on the 70ms floor, so the table stops there and
// dropIntervalFor clamps.
const DROP_INTERVALS = [
  1000, 780, 608.4, 474.552, 370.15056, 288.7174368, 225.199600704, 175.6556885491, 137.0114370683,
  106.8689209133, 83.3577583124, 70,
];
const DROP_INTERVAL_MIN = 70;

// 16ms of simulation per step. Fine enough that gravity feels identical, coarse
// enough that a long marathon stays inside the server's replay budget.
const FIXED_DT_MS = 16;

const OP_LEFT = 0;
const OP_RIGHT = 1;
const OP_ROTATE = 2;
const OP_SOFT_DROP = 3;
const OP_HARD_DROP = 4;

function dropIntervalFor(level) {
  if (level < 1) return DROP_INTERVALS[0];
  if (level > DROP_INTERVALS.length) return DROP_INTERVAL_MIN;
  return DROP_INTERVALS[level - 1];
}

// 7-bag randomizer: every piece appears once per bag, so droughts are bounded.
function nextFromBag(state) {
  if (!state.bag || state.bag.length === 0) {
    state.bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = state.bag.length - 1; i > 0; i--) {
      const j = Math.floor(state.rng() * (i + 1));
      const tmp = state.bag[i];
      state.bag[i] = state.bag[j];
      state.bag[j] = tmp;
    }
  }
  const type = state.bag.pop();
  const def = PIECES[type];
  return {
    type,
    color: def.color,
    size: def.size,
    cells: def.cells.map((c) => c.slice()),
    x: Math.floor((COLS - def.size) / 2),
    y: 0,
  };
}

function collides(state, piece, dx, dy, cells) {
  const shape = cells || piece.cells;
  for (const [cx, cy] of shape) {
    const x = piece.x + cx + dx;
    const y = piece.y + cy + dy;
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && state.grid[y][x]) return true;
  }
  return false;
}

// Clockwise rotation inside the piece's own size x size box.
function rotatedCells(piece) {
  return piece.cells.map(([x, y]) => [piece.size - 1 - y, x]);
}

function ghostOffset(state) {
  let dy = 0;
  while (!collides(state, state.current, 0, dy + 1)) dy++;
  return dy;
}

function createState(rng) {
  const state = {
    rng,
    grid: Array.from({ length: ROWS }, () => new Array(COLS).fill(null)),
    bag: [],
    score: 0,
    lines: 0,
    level: 1,
    dropTimer: 0,
    dropInterval: DROP_INTERVALS[0],
    over: false,
  };
  state.current = nextFromBag(state);
  state.next = nextFromBag(state);
  return state;
}

function spawn(state) {
  state.current = state.next;
  state.next = nextFromBag(state);
  if (collides(state, state.current, 0, 0)) {
    state.over = true;
    return false;
  }
  return true;
}

function clearLines(state) {
  // Each entry carries the row's COLOURS as well as its index: the client
  // draws an explosion from them, and by the time it sees this result the row
  // has already been spliced out of the grid.
  const clearedRows = [];
  for (let y = ROWS - 1; y >= 0; y--) {
    if (state.grid[y].every((cell) => cell)) {
      clearedRows.push({ y, cells: state.grid[y].slice() });
      state.grid.splice(y, 1);
      state.grid.unshift(new Array(COLS).fill(null));
      y++; // re-check the row that just slid down into this index
    }
  }
  const cleared = clearedRows.length;
  if (!cleared) return { cleared: 0, rows: [] };

  state.lines += cleared;
  state.score += LINE_SCORES[cleared] * state.level;
  // Level up every 8 lines - the wide 12-column board gives more room, so the
  // ramp is deliberately steep to compensate.
  const newLevel = Math.floor(state.lines / 8) + 1;
  if (newLevel !== state.level) {
    state.level = newLevel;
    state.dropInterval = dropIntervalFor(newLevel);
  }
  return { cleared, rows: clearedRows };
}

function lockPiece(state) {
  for (const [cx, cy] of state.current.cells) {
    const y = state.current.y + cy;
    if (y >= 0) state.grid[y][state.current.x + cx] = state.current.color;
  }
  const result = clearLines(state);
  const alive = spawn(state);
  return { locked: true, cleared: result.cleared, rows: result.rows, over: !alive };
}

const NOTHING = { locked: false, cleared: 0, rows: [], over: false };

function applyInput(state, op) {
  if (state.over) return NOTHING;
  switch (op) {
    case OP_LEFT:
    case OP_RIGHT: {
      const dx = op === OP_LEFT ? -1 : 1;
      if (!collides(state, state.current, dx, 0)) {
        state.current.x += dx;
        return { ...NOTHING, moved: true };
      }
      return NOTHING;
    }
    case OP_ROTATE: {
      const cells = rotatedCells(state.current);
      // Simple wall kicks: in place, then one/two cells left or right.
      for (const kick of [0, -1, 1, -2, 2]) {
        if (!collides(state, state.current, kick, 0, cells)) {
          state.current.cells = cells;
          state.current.x += kick;
          return { ...NOTHING, rotated: true };
        }
      }
      return NOTHING;
    }
    case OP_SOFT_DROP: {
      if (collides(state, state.current, 0, 1)) return lockPiece(state);
      state.current.y++;
      state.score += 1;
      return { ...NOTHING, softDropped: true };
    }
    case OP_HARD_DROP: {
      const dy = ghostOffset(state);
      state.current.y += dy;
      state.score += dy * 2;
      return lockPiece(state);
    }
    default:
      return null; // unknown opcode - the caller treats this as structural
  }
}

// Exactly one FIXED_DT_MS of gravity.
function step(state) {
  if (state.over) return NOTHING;
  state.dropTimer += FIXED_DT_MS;
  if (state.dropTimer < state.dropInterval) return NOTHING;
  // Carry the remainder rather than resetting to zero - resetting made the
  // real drop rate depend on frame rate.
  state.dropTimer -= state.dropInterval;
  if (collides(state, state.current, 0, 1)) return lockPiece(state);
  state.current.y++;
  return NOTHING;
}

const api = {
  COLS,
  ROWS,
  PIECES,
  LINE_SCORES,
  DROP_INTERVALS,
  DROP_INTERVAL_MIN,
  FIXED_DT_MS,
  OP_LEFT,
  OP_RIGHT,
  OP_ROTATE,
  OP_SOFT_DROP,
  OP_HARD_DROP,
  dropIntervalFor,
  createState,
  applyInput,
  step,
  collides,
  rotatedCells,
  ghostOffset,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.FallingBlocksEngine = api;
}
