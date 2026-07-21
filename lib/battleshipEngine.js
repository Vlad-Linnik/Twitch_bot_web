// Pure, I/O-free classic Battleship rules - server-only (required by
// realtime/quickMatchManager.js), never shipped to the browser, same
// convention as realtime/durakEngine.js. Standard 10x10 grid, Russian-standard
// fleet (one 4-cell, two 3-cell, three 2-cell, four 1-cell), and the classic
// "ships may not touch, even diagonally" adjacency rule. A hit grants another
// shot (the common "classic" digital-implementation convention) rather than
// always passing the turn.
//
// Shot outcomes are three-valued so the client can distinguish them (the
// feature request's "ранил / уничтожил / атакованный"):
//   "hit"  - a cell of a ship that is NOT yet fully sunk (wounded)
//   "kill" - a cell of a ship that is now fully sunk (destroyed) - every cell
//            of a sunk ship is rewritten to "kill"
//   "miss" - open water; also every cell auto-marked around a just-sunk ship,
//            which by the adjacency rule can never hold a ship (attacked)
//
// Timing (enforced by the manager, which owns the wall clock - this module is
// pure and only supplies the durations + the deadline mutation): 1 minute to
// place a fleet, 5 minutes for the battle itself. See onDeadline().
"use strict";

const BOARD_SIZE = 10;
// One 4-cell, two 3-cell, three 2-cell, four 1-cell = 10 ships, 20 cells.
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

const PLACEMENT_MS = 60 * 1000;
const BATTLE_MS = 5 * 60 * 1000;

function createInitialState() {
  return {
    phase: "placement", // placement | battle | finished
    boards: [
      { ships: null, shots: {} },
      { ships: null, shots: {} },
    ],
    ready: [false, false],
    turnSeat: 0,
    winnerSeat: null,
  };
}

function isStraightLine(cells) {
  if (cells.length === 1) return true;
  const rows = cells.map((c) => c[0]);
  const cols = cells.map((c) => c[1]);
  const sameRow = rows.every((r) => r === rows[0]);
  const sameCol = cols.every((c) => c === cols[0]);
  if (sameRow) {
    const sorted = [...cols].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
    return true;
  }
  if (sameCol) {
    const sorted = [...rows].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
    return true;
  }
  return false;
}

// `ships`: [{ cells: [[r,c], ...] }, ...] - exactly FLEET.length ships, sizes
// matching FLEET as a multiset (order doesn't matter), each a contiguous
// straight line, all cells in bounds, no two ships sharing a cell, and no two
// ships touching (the 8-neighbourhood adjacency rule).
function validatePlacement(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) return { ok: false, error: "ship-count" };
  const sizes = ships.map((s) => (Array.isArray(s.cells) ? s.cells.length : 0)).sort((a, b) => a - b);
  const expected = [...FLEET].sort((a, b) => a - b);
  if (sizes.length !== expected.length || sizes.some((v, i) => v !== expected[i])) {
    return { ok: false, error: "ship-sizes" };
  }
  const owner = new Map(); // cellKey -> ship index that occupies it
  for (let i = 0; i < ships.length; i++) {
    if (!isStraightLine(ships[i].cells)) return { ok: false, error: "invalid-shape" };
    for (const [r, c] of ships[i].cells) {
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return { ok: false, error: "out-of-bounds" };
      const key = r + "," + c;
      if (owner.has(key)) return { ok: false, error: "overlap" };
      owner.set(key, i);
    }
  }
  // Adjacency: a cell of one ship must not sit in the 8-neighbourhood of any
  // other ship's cell (ships can't touch, even at a corner).
  for (let i = 0; i < ships.length; i++) {
    for (const [r, c] of ships[i].cells) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const other = owner.get(r + dr + "," + (c + dc));
          if (other !== undefined && other !== i) return { ok: false, error: "adjacent" };
        }
      }
    }
  }
  return { ok: true };
}

// Copy a validated `ships` array into a board (deep, with an all-false hits
// mask). Used both by a real placement and by the auto-place-on-timeout path.
function installFleet(board, ships) {
  board.ships = ships.map((s) => ({
    cells: s.cells.map(([r, c]) => [r, c]),
    hits: new Array(s.cells.length).fill(false),
  }));
}

function maybeStartBattle(state) {
  if (state.ready[0] && state.ready[1]) {
    state.phase = "battle";
    state.turnSeat = Math.random() < 0.5 ? 0 : 1;
  }
}

function applyPlacement(state, seat, ships) {
  if (state.phase !== "placement") return { ok: false, error: "wrong-phase" };
  if (state.ready[seat]) return { ok: false, error: "already-ready" };
  const check = validatePlacement(ships);
  if (!check.ok) return check;
  installFleet(state.boards[seat], ships);
  state.ready[seat] = true;
  maybeStartBattle(state);
  return { ok: true };
}

// Rewrites every cell of a just-sunk ship to "kill", then auto-marks every
// in-bounds cell around it as "miss" (open water it's now known to be, by the
// adjacency rule) - unless that neighbour was already shot at.
function markSunk(board, ship) {
  const shipKeys = new Set(ship.cells.map(([r, c]) => r + "," + c));
  for (const [r, c] of ship.cells) board.shots[r + "," + c] = "kill";
  for (const [r, c] of ship.cells) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
        const nk = nr + "," + nc;
        if (shipKeys.has(nk)) continue;
        if (!board.shots[nk]) board.shots[nk] = "miss";
      }
    }
  }
}

function applyFire(state, seat, cell) {
  if (state.phase !== "battle") return { ok: false, error: "wrong-phase" };
  if (state.turnSeat !== seat) return { ok: false, error: "not-your-turn" };
  if (!Array.isArray(cell) || cell.length !== 2) return { ok: false, error: "bad-cell" };
  const [r, c] = cell;
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
    return { ok: false, error: "out-of-bounds" };
  }
  const targetSeat = seat === 0 ? 1 : 0;
  const board = state.boards[targetSeat];
  const key = r + "," + c;
  if (board.shots[key]) return { ok: false, error: "already-fired" };

  let hitShip = null;
  let hitIndex = -1;
  for (const ship of board.ships) {
    const idx = ship.cells.findIndex(([sr, sc]) => sr === r && sc === c);
    if (idx >= 0) {
      hitShip = ship;
      hitIndex = idx;
      break;
    }
  }

  if (hitShip) {
    hitShip.hits[hitIndex] = true;
    const sunk = hitShip.hits.every(Boolean);
    if (sunk) {
      markSunk(board, hitShip); // rewrites this ship's cells to "kill" + surrounds them
    } else {
      board.shots[key] = "hit";
    }
    const allSunk = board.ships.every((s) => s.hits.every(Boolean));
    if (allSunk) {
      state.phase = "finished";
      state.winnerSeat = seat;
    }
    // A hit (or kill) grants another shot - turnSeat stays the same.
  } else {
    board.shots[key] = "miss";
    state.turnSeat = targetSeat;
  }
  return { ok: true, outcome: hitShip ? (hitShip.hits.every(Boolean) ? "kill" : "hit") : "miss" };
}

// realtime/quickMatchManager.js's turn-based contract is a single
// applyMove(state, seat, move) entrypoint - this dispatches Battleship's two
// distinct phases (placement, then firing) through that one entrypoint via
// `move.type`, rather than the manager needing to know Battleship has two
// kinds of moves at all.
function applyMove(state, seat, move) {
  if (!move || typeof move !== "object") return { ok: false, error: "bad-move" };
  if (move.type === "place") return applyPlacement(state, seat, move.ships);
  if (move.type === "fire") return applyFire(state, seat, move.cell);
  return { ok: false, error: "unknown-move-type" };
}

function checkGameOver(state) {
  if (state.phase === "finished" && state.winnerSeat != null) return { winnerSeat: state.winnerSeat };
  return null;
}

// --- Timing hooks (optional interface the manager probes for) ---------------
// The manager owns the wall clock; this module only names the current phase's
// deadline and mutates state when the manager reports it has elapsed.

function deadlineTagFor(state) {
  if (state.phase === "placement") return "placement";
  if (state.phase === "battle") return "battle";
  return null;
}

function deadlineMsForTag(tag) {
  if (tag === "placement") return PLACEMENT_MS;
  if (tag === "battle") return BATTLE_MS;
  return null;
}

// Called by the manager when the current phase's deadline has elapsed.
// Placement: auto-place a random fleet for anyone who hasn't submitted, then
// start the battle. Battle: end it immediately, the winner being whoever has
// dealt more damage (more of the opponent's ship cells hit); an exact tie is a
// draw. Returns { gameOver } only for the battle case (checkGameOver alone
// can't express a draw).
function onDeadline(state) {
  if (state.phase === "placement") {
    for (let seat = 0; seat < 2; seat++) {
      if (!state.ready[seat]) {
        installFleet(state.boards[seat], randomFleet());
        state.ready[seat] = true;
      }
    }
    maybeStartBattle(state);
    return {};
  }
  if (state.phase === "battle") {
    const damage = [0, 1].map((seat) => {
      const opp = seat === 0 ? 1 : 0;
      return state.boards[opp].ships.reduce((n, s) => n + s.hits.filter(Boolean).length, 0);
    });
    state.phase = "finished";
    if (damage[0] === damage[1]) {
      state.winnerSeat = null;
      return { gameOver: { draw: true } };
    }
    state.winnerSeat = damage[0] > damage[1] ? 0 : 1;
    return { gameOver: { winnerSeat: state.winnerSeat } };
  }
  return {};
}

// A random legal fleet (respects both the new FLEET sizes and the adjacency
// rule). Used for auto-place-on-timeout; the client mirrors this for its own
// "Auto-place" button. `occupied` accumulates each placed ship's cells AND
// their neighbours, so the next ship can neither overlap nor touch.
function randomFleet() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const ships = [];
    const occupied = new Set();
    let ok = true;
    for (const size of FLEET) {
      let placed = false;
      for (let t = 0; t < 300 && !placed; t++) {
        const horiz = Math.random() < 0.5;
        const row = Math.floor(Math.random() * BOARD_SIZE);
        const col = Math.floor(Math.random() * BOARD_SIZE);
        const cells = [];
        for (let i = 0; i < size; i++) cells.push(horiz ? [row, col + i] : [row + i, col]);
        const inBounds = cells.every(([r, c]) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE);
        if (!inBounds) continue;
        if (cells.some(([r, c]) => occupied.has(r + "," + c))) continue;
        ships.push({ cells });
        for (const [r, c] of cells) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) occupied.add(r + dr + "," + (c + dc));
          }
        }
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return ships;
  }
  return null;
}

// Critical privacy boundary: the opponent's board only ever exposes shot
// outcomes (miss/hit/kill) plus the full shape of ships that are ALREADY fully
// sunk (safe - every one of their cells is already known). An opponent ship
// with any unhit cell never appears here at all.
function serializeForSeat(state, seat) {
  const oppSeat = seat === 0 ? 1 : 0;
  if (state.phase === "placement") {
    return {
      phase: state.phase,
      ready: state.ready.slice(),
      myShips: state.boards[seat].ships,
    };
  }
  const myBoard = state.boards[seat];
  const oppBoard = state.boards[oppSeat];
  return {
    phase: state.phase,
    turnSeat: state.turnSeat,
    winnerSeat: state.winnerSeat,
    myShips: myBoard.ships,
    myShots: myBoard.shots,
    opponentShots: oppBoard.shots,
    opponentSunkShips: oppBoard.ships.filter((s) => s.hits.every(Boolean)).map((s) => s.cells),
  };
}

// Fair-view spectator serialization: never reveals an unsunk ship's cells on
// EITHER board - exactly the same privacy boundary serializeForSeat already
// enforces for a seated player's view of their opponent (opponentSunkShips),
// just applied symmetrically to both boards at once instead of one. During
// placement there is nothing fair to show at all (both players are still
// placing), so the client gets just the phase and renders a waiting message.
function serializeForSpectator(state) {
  if (state.phase === "placement") return { phase: state.phase };
  return {
    phase: state.phase,
    turnSeat: state.turnSeat,
    winnerSeat: state.winnerSeat,
    boards: state.boards.map((b) => ({
      shots: b.shots,
      sunkShips: b.ships.filter((s) => s.hits.every(Boolean)).map((s) => s.cells),
    })),
  };
}

module.exports = {
  BOARD_SIZE,
  FLEET,
  PLACEMENT_MS,
  BATTLE_MS,
  createInitialState,
  validatePlacement,
  applyPlacement,
  applyFire,
  applyMove,
  checkGameOver,
  deadlineTagFor,
  deadlineMsForTag,
  onDeadline,
  randomFleet,
  serializeForSeat,
  serializeForSpectator,
};
