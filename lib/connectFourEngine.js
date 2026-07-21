// Pure, I/O-free Connect Four rules - server-only (required by realtime/
// quickMatchManager.js), same convention as the other lib/*Engine.js files.
// Classic 7-wide, 6-tall board. Fairness of who moves first comes from
// quickMatchManager.js's random seat assignment at match time, not from
// anything in here - seat 0 always opens.
"use strict";

const ROWS = 6;
const COLS = 7;

// Per-move clock (see "Timing hooks" below) - loses the game if you let it
// run out, same spirit as lib/battleshipEngine.js's phase deadlines.
const MOVE_MS = 30 * 1000;

function createInitialState() {
  return {
    grid: Array.from({ length: ROWS }, () => new Array(COLS).fill(null)),
    turnSeat: 0,
    winnerSeat: null,
    draw: false,
  };
}

function isBoardFull(grid) {
  return grid[0].every((cell) => cell !== null);
}

function countDirection(grid, row, col, dr, dc, seat) {
  let r = row + dr;
  let c = col + dc;
  let count = 0;
  while (r >= 0 && r < ROWS && c >= 0 && c < COLS && grid[r][c] === seat) {
    count++;
    r += dr;
    c += dc;
  }
  return count;
}

// Only checks the 4 direction-pairs passing through the just-placed cell -
// cheap, no full-board rescan needed after every drop.
function checkWinFrom(grid, row, col, seat) {
  const directionPairs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of directionPairs) {
    const count = 1 + countDirection(grid, row, col, dr, dc, seat) + countDirection(grid, row, col, -dr, -dc, seat);
    if (count >= 4) return true;
  }
  return false;
}

// move: { col }. Drops into the lowest empty row of that column.
function applyMove(state, seat, move) {
  if (state.winnerSeat != null || state.draw) return { ok: false, error: "game-over" };
  if (state.turnSeat !== seat) return { ok: false, error: "not-your-turn" };
  const col = move && move.col;
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return { ok: false, error: "bad-column" };

  let row = -1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (state.grid[r][col] === null) {
      row = r;
      break;
    }
  }
  if (row === -1) return { ok: false, error: "column-full" };

  state.grid[row][col] = seat;
  if (checkWinFrom(state.grid, row, col, seat)) {
    state.winnerSeat = seat;
  } else if (isBoardFull(state.grid)) {
    state.draw = true;
  } else {
    state.turnSeat = seat === 0 ? 1 : 0;
  }
  return { ok: true };
}

function checkGameOver(state) {
  if (state.winnerSeat != null) return { winnerSeat: state.winnerSeat };
  if (state.draw) return { draw: true };
  return null;
}

// No hidden info - both seats see the full board.
function serializeForSeat(state) {
  return state;
}

// --- Timing hooks (optional interface realtime/quickMatchManager.js probes
// for - see lib/battleshipEngine.js's own copy of this comment). turnSeat
// alone is a fine deadline tag: Connect Four never passes, so it flips on
// every single move and is therefore always different from whatever tag was
// running before.
function deadlineTagFor(state) {
  if (state.winnerSeat != null || state.draw) return null;
  return "seat-" + state.turnSeat;
}

function deadlineMsForTag() {
  return MOVE_MS;
}

// Whoever's clock ran out forfeits, same as resigning.
function onDeadline(state) {
  if (state.winnerSeat != null || state.draw) return {};
  state.winnerSeat = state.turnSeat === 0 ? 1 : 0;
  return {};
}

module.exports = {
  ROWS,
  COLS,
  MOVE_MS,
  createInitialState,
  applyMove,
  checkGameOver,
  serializeForSeat,
  deadlineTagFor,
  deadlineMsForTag,
  onDeadline,
};
