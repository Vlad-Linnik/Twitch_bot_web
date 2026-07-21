// Pure, I/O-free international (short) backgammon rules - server-only
// (required by realtime/quickMatchManager.js), same convention as the other
// lib/*Engine.js files. The single riskiest module in the whole 6-game
// feature (see the implementation plan) - the "must use the maximum number
// of playable dice" rule is notoriously easy to get subtly wrong, so legal
// move generation here is a brute-force search over the small space of
// die/move combinations rather than an analytic derivation.
//
// Board representation: `points[24]`, index 0 = point 1, index 23 = point 24
// (standard backgammon notation is 1-based; this file is 0-based
// internally). A signed count: positive = seat 0's checkers, negative =
// seat 1's. Seat 0 moves from point 24 toward point 1 (decreasing index) and
// bears off there; seat 1 moves the opposite way (increasing index) and
// bears off past point 24. Seat 0's home board is points 1-6 (index 0-5);
// seat 1's is points 19-24 (index 18-23) - each is also where the OTHER
// seat's checkers re-enter after being hit to the bar, since a bar entry
// starts the same journey a fresh checker would.
"use strict";

// Per-decision clock (see "Timing hooks" near the bottom) - running out
// forfeits the game, same spirit as lib/battleshipEngine.js's phase
// deadlines.
const TURN_MS = 60 * 1000;

function createInitialState() {
  const points = new Array(24).fill(0);
  // Standard starting position: 2 on the 24-point, 5 on the 13-point, 3 on
  // the 8-point, 5 on the 6-point - mirrored for the other seat.
  points[23] = 2;
  points[12] = 5;
  points[7] = 3;
  points[5] = 5;
  points[0] = -2;
  points[11] = -5;
  points[16] = -3;
  points[18] = -5;
  return {
    points,
    bar: [0, 0],
    borneOff: [0, 0],
    dice: [],
    movesRemaining: [],
    turnSeat: 0, // fairness comes from quickMatchManager's random SEAT assignment, not from here
    turnPhase: "roll", // "roll" | "move"
    turnNumber: 1, // display-only turn counter, shown client-side instead of the removed doubling cube
    winnerSeat: null,
  };
}

function pointOwner(points, idx) {
  if (points[idx] > 0) return 0;
  if (points[idx] < 0) return 1;
  return null;
}

function pointCount(points, idx) {
  return Math.abs(points[idx]);
}

function homeRange(seat) {
  return seat === 0 ? [0, 5] : [18, 23];
}

// Pips needed to bear a checker at `idx` off the board for `seat`.
function distanceToBearOff(seat, idx) {
  return seat === 0 ? idx + 1 : 24 - idx;
}

// A point can be landed on if it's empty, already owned by `seat`, or held
// by exactly one opposing checker (a blot - landing there hits it).
function canLandOn(board, seat, idx) {
  if (idx < 0 || idx > 23) return false;
  const owner = pointOwner(board.points, idx);
  if (owner === null || owner === seat) return true;
  return pointCount(board.points, idx) === 1;
}

function allCheckersHome(board, seat) {
  if (board.bar[seat] > 0) return false;
  const [lo, hi] = homeRange(seat);
  for (let i = 0; i < 24; i++) {
    if (i >= lo && i <= hi) continue;
    if (pointOwner(board.points, i) === seat) return false;
  }
  return true;
}

function farthestCheckerDistance(board, seat) {
  const [lo, hi] = homeRange(seat);
  let farthest = 0;
  for (let i = lo; i <= hi; i++) {
    if (pointOwner(board.points, i) === seat) {
      const d = distanceToBearOff(seat, i);
      if (d > farthest) farthest = d;
    }
  }
  return farthest;
}

// Every legal single-checker move for `seat` playing die `d`, given the
// current board (points + bar only - the lightweight shape the search below
// clones). While `seat` has a checker on the bar, entering it is the ONLY
// legal move (standard rule: you may not move anything else until the bar is
// clear).
function movesForDie(board, seat, d) {
  const moves = [];
  if (board.bar[seat] > 0) {
    const entryIdx = seat === 0 ? 24 - d : d - 1;
    if (canLandOn(board, seat, entryIdx)) moves.push({ from: "bar", to: entryIdx, die: d });
    return moves;
  }
  const [lo, hi] = homeRange(seat);
  const canBearOff = allCheckersHome(board, seat);
  const farthest = canBearOff ? farthestCheckerDistance(board, seat) : 0;
  for (let i = 0; i < 24; i++) {
    if (pointOwner(board.points, i) !== seat) continue;
    const dest = seat === 0 ? i - d : i + d;
    if (dest >= 0 && dest <= 23) {
      if (canLandOn(board, seat, dest)) moves.push({ from: i, to: dest, die: d });
    } else if (canBearOff && i >= lo && i <= hi) {
      const dist = distanceToBearOff(seat, i);
      if (d === dist || (d > dist && dist === farthest)) {
        moves.push({ from: i, to: "off", die: d });
      }
    }
  }
  return moves;
}

function cloneBoard(board) {
  return { points: board.points.slice(), bar: board.bar.slice(), borneOff: board.borneOff.slice() };
}

// Pure (non-mutating) move application, used only by the search below to
// explore hypothetical continuations - the real, mutating move happens in
// applyMoveInPlace once a move has been validated via legalMoves().
function applyMoveInternal(board, seat, move) {
  const next = cloneBoard(board);
  if (move.from === "bar") next.bar[seat] -= 1;
  else next.points[move.from] += seat === 0 ? -1 : 1;

  if (move.to === "off") {
    next.borneOff[seat] += 1;
  } else {
    const owner = pointOwner(next.points, move.to);
    if (owner !== null && owner !== seat) {
      next.points[move.to] = 0;
      next.bar[owner] += 1;
    }
    next.points[move.to] += seat === 0 ? 1 : -1;
  }
  return next;
}

// The core of the "maximum dice usage" rule: the greatest number of the
// given dice that CAN be played in some order from this board, searched
// exhaustively (remainingDice.length is at most 4, and each die's distinct
// values are de-duplicated before recursing, so this stays cheap).
function maxPlayableCount(board, seat, remainingDice) {
  if (remainingDice.length === 0) return 0;
  let best = 0;
  const tried = new Set();
  for (let i = 0; i < remainingDice.length; i++) {
    const d = remainingDice[i];
    if (tried.has(d)) continue;
    tried.add(d);
    const moves = movesForDie(board, seat, d);
    for (const move of moves) {
      const nextBoard = applyMoveInternal(board, seat, move);
      const rest = remainingDice.slice(0, i).concat(remainingDice.slice(i + 1));
      const total = 1 + maxPlayableCount(nextBoard, seat, rest);
      if (total > best) best = total;
    }
  }
  return best;
}

// Every move legal to play RIGHT NOW, restricted to moves that keep the
// player on a path to playing the maximum number of this turn's dice overall
// (a move that would "waste" a die when a fuller sequence exists elsewhere is
// excluded, even though it's playable in isolation). Also enforces the
// specific "must play the LARGER die if only one of two distinct dice can be
// played at all, and both are individually playable" rule - the one part of
// max-dice-usage that isn't simply "maximize the count".
function legalMoves(state, seat) {
  if (state.winnerSeat != null) return [];
  if (state.turnSeat !== seat || state.turnPhase !== "move") return [];
  const remaining = state.movesRemaining;
  if (!remaining || remaining.length === 0) return [];

  const overallMax = maxPlayableCount(state, seat, remaining);
  if (overallMax === 0) return [];

  let results = [];
  const tried = new Set();
  for (let i = 0; i < remaining.length; i++) {
    const d = remaining[i];
    if (tried.has(d)) continue;
    tried.add(d);
    const moves = movesForDie(state, seat, d);
    for (const move of moves) {
      const nextBoard = applyMoveInternal(state, seat, move);
      const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
      if (1 + maxPlayableCount(nextBoard, seat, rest) === overallMax) results.push(move);
    }
  }

  if (remaining.length === 2 && remaining[0] !== remaining[1] && overallMax === 1) {
    const higher = Math.max(remaining[0], remaining[1]);
    const higherPlayableAlone = movesForDie(state, seat, higher).length > 0;
    if (higherPlayableAlone) results = results.filter((m) => m.die === higher);
  }

  return results;
}

function applyMoveInPlace(state, seat, move) {
  if (move.from === "bar") state.bar[seat] -= 1;
  else state.points[move.from] += seat === 0 ? -1 : 1;

  if (move.to === "off") {
    state.borneOff[seat] += 1;
  } else {
    const owner = pointOwner(state.points, move.to);
    if (owner !== null && owner !== seat) {
      state.points[move.to] = 0;
      state.bar[owner] += 1;
    }
    state.points[move.to] += seat === 0 ? 1 : -1;
  }
}

function endTurn(state) {
  state.dice = [];
  state.movesRemaining = [];
  state.turnPhase = "roll";
  state.turnSeat = state.turnSeat === 0 ? 1 : 0;
  state.turnNumber += 1;
}

// Seedable for tests (an injected `rng` returning [0,1)); production calls
// via doRoll always use Math.random.
function rollDice(rng) {
  const random = rng || Math.random;
  const d1 = 1 + Math.floor(random() * 6);
  const d2 = 1 + Math.floor(random() * 6);
  return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
}

function doRoll(state, seat) {
  if (state.turnSeat !== seat) return { ok: false, error: "not-your-turn" };
  if (state.turnPhase !== "roll") return { ok: false, error: "already-rolled" };
  state.dice = rollDice();
  state.movesRemaining = state.dice.slice();
  state.turnPhase = "move";
  // No legal move at all with this roll (e.g. every entry point blocked
  // while on the bar) - the turn is forfeited automatically, same as the
  // dice simply not being playable in over-the-board rules.
  if (legalMoves(state, seat).length === 0) endTurn(state);
  return { ok: true };
}

function doMove(state, seat, move) {
  if (state.turnSeat !== seat) return { ok: false, error: "not-your-turn" };
  if (state.turnPhase !== "move") return { ok: false, error: "must-roll-first" };
  const legal = legalMoves(state, seat);
  const match = legal.find((m) => m.die === move.die && String(m.from) === String(move.from) && String(m.to) === String(move.to));
  if (!match) return { ok: false, error: "illegal-move" };

  applyMoveInPlace(state, seat, match);
  state.movesRemaining.splice(state.movesRemaining.indexOf(match.die), 1);

  if (state.borneOff[seat] === 15) {
    state.winnerSeat = seat;
    return { ok: true };
  }
  if (state.movesRemaining.length === 0 || legalMoves(state, seat).length === 0) endTurn(state);
  return { ok: true };
}

function applyMove(state, seat, move) {
  if (state.winnerSeat != null) return { ok: false, error: "game-over" };
  if (!move || typeof move !== "object") return { ok: false, error: "bad-move" };
  switch (move.type) {
    case "roll":
      return doRoll(state, seat);
    case "move":
      return doMove(state, seat, move);
    default:
      return { ok: false, error: "unknown-move-type" };
  }
}

function checkGameOver(state) {
  return state.winnerSeat != null ? { winnerSeat: state.winnerSeat } : null;
}

// No hidden info in backgammon - both seats see the full board, but each gets
// its OWN legalMoves() (a client-side move-highlight hint: legalMoves()
// already returns [] for the seat that isn't on the clock right now, so this
// is just "whatever this seat could legally play this instant", never the
// opponent's).
function serializeForSeat(state, seat) {
  return { ...state, legalMoves: legalMoves(state, seat) };
}

// --- Timing hooks (optional interface realtime/quickMatchManager.js probes
// for - see lib/battleshipEngine.js's own copy of this comment). The tag
// names whichever decision is currently live (a turn's roll or move phase) so
// it changes the instant that decision resolves into the next one, resetting
// the clock each time.
function deadlineTagFor(state) {
  if (state.winnerSeat != null) return null;
  return "turn-" + state.turnSeat + "-" + state.turnPhase;
}

function deadlineMsForTag() {
  return TURN_MS;
}

// Whoever was on the clock forfeits.
function onDeadline(state) {
  if (state.winnerSeat != null) return {};
  const timedOutSeat = state.turnSeat;
  state.winnerSeat = timedOutSeat === 0 ? 1 : 0;
  return {};
}

module.exports = {
  TURN_MS,
  createInitialState,
  rollDice,
  legalMoves,
  applyMove,
  checkGameOver,
  serializeForSeat,
  deadlineTagFor,
  deadlineMsForTag,
  onDeadline,
};
