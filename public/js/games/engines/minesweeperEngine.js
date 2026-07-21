// Pure, I/O-free Minesweeper board logic - no DOM/timer/score references on
// purpose, so it can be unit-tested under node:test (see tests/
// minesweeperEngine.test.js) AND run client-side (public/js/games/
// minesweeper.js), the same "pure engine, bespoke game-loop caller" split as
// realtime/durakEngine.js. This repo has no JS bundler, so lib/ never reaches
// the browser - this file lives under public/js/games/engines/ instead (a
// plain static asset, loaded via <script> before minesweeper.js) and exports
// itself as a CommonJS module OR a browser global depending on which
// environment loads it.
"use strict";

// Only Beginner is offered - see minesweeper.js's DIFFICULTY_KEY. Kept as a
// keyed object (rather than inlining rows/cols/mines/points) so DIFFICULTIES
// stays the single source of truth generateBoard()/minesweeper.js both read.
const DIFFICULTIES = {
  beginner: { rows: 9, cols: 9, mines: 10, points: 100 },
};

// Deterministic PRNG (mulberry32) so tests can assert exact board layouts.
// The client passes Math.random by default (see minesweeper.js) - only tests
// need a seeded one.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function make2d(rows, cols, fill) {
  return Array.from({ length: rows }, () => new Array(cols).fill(fill));
}

// Mines are placed excluding `safeRow`/`safeCol` and its 8 neighbors, so the
// very first reveal of a fresh board can never be a mine (standard "first
// click is safe" Minesweeper rule). A bonus cell (see scoring design in the
// plan: capped client-side at 6 procs / +60s per run) is placed on ~35% of
// boards, always on a non-mine cell.
function generateBoard(difficultyKey, safeRow, safeCol, rng) {
  const diff = DIFFICULTIES[difficultyKey];
  if (!diff) throw new Error("unknown difficulty: " + difficultyKey);
  const { rows, cols, mines } = diff;
  const random = rng || Math.random;

  const safeSet = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = safeRow + dr;
      const c = safeCol + dc;
      if (r >= 0 && r < rows && c >= 0 && c < cols) safeSet.add(r + "," + c);
    }
  }

  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!safeSet.has(r + "," + c)) candidates.push([r, c]);
    }
  }
  shuffleInPlace(candidates, random);

  const isMine = make2d(rows, cols, false);
  const minePositions = candidates.slice(0, mines);
  for (const [r, c] of minePositions) isMine[r][c] = true;

  const adjacency = make2d(rows, cols, 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isMine[r][c]) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && isMine[nr][nc]) count++;
        }
      }
      adjacency[r][c] = count;
    }
  }

  let bonus = null;
  const nonMineCandidates = candidates.slice(mines);
  if (nonMineCandidates.length > 0 && random() < 0.35) {
    const [r, c] = nonMineCandidates[Math.floor(random() * nonMineCandidates.length)];
    bonus = { r, c };
  }

  return {
    difficultyKey,
    rows,
    cols,
    points: diff.points,
    isMine,
    adjacency,
    bonus,
    revealed: make2d(rows, cols, false),
    flagged: make2d(rows, cols, false),
  };
}

// Flood-fills a zero-adjacency region starting at (row, col). Returns the list
// of newly revealed cells, whether a mine was hit, and whether the (single)
// bonus cell was among the newly revealed cells.
function revealCell(board, row, col) {
  if (board.flagged[row][col] || board.revealed[row][col]) {
    return { changed: [], exploded: false, bonus: false };
  }

  if (board.isMine[row][col]) {
    board.revealed[row][col] = true;
    return { changed: [[row, col]], exploded: true, bonus: false };
  }

  const changed = [];
  const seen = new Set();
  const stack = [[row, col]];
  let bonusHit = false;

  while (stack.length) {
    const [r, c] = stack.pop();
    const key = r + "," + c;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r < 0 || r >= board.rows || c < 0 || c >= board.cols) continue;
    if (board.isMine[r][c] || board.flagged[r][c] || board.revealed[r][c]) continue;

    board.revealed[r][c] = true;
    changed.push([r, c]);
    if (board.bonus && board.bonus.r === r && board.bonus.c === c) bonusHit = true;

    if (board.adjacency[r][c] === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          stack.push([r + dr, c + dc]);
        }
      }
    }
  }

  return { changed, exploded: false, bonus: bonusHit };
}

function toggleFlag(board, row, col) {
  if (board.revealed[row][col]) return null;
  board.flagged[row][col] = !board.flagged[row][col];
  return board.flagged[row][col];
}

// Chording: clicking an already-revealed numbered cell whose surrounding flag
// count matches its own number reveals every other unflagged neighbor in one
// go, the standard Minesweeper shortcut for clearing counted cells without
// clicking each neighbor by hand. A mismatched flag count is a no-op (same
// as clicking a number with too few/no flags around it does nothing) so a
// misplaced flag can't be chorded around accidentally.
function chordCell(board, row, col) {
  if (!board.revealed[row][col] || board.isMine[row][col]) {
    return { changed: [], exploded: false, bonus: false };
  }
  const number = board.adjacency[row][col];
  if (number === 0) return { changed: [], exploded: false, bonus: false };

  const neighbors = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < board.rows && nc >= 0 && nc < board.cols) neighbors.push([nr, nc]);
    }
  }

  let flagCount = 0;
  for (const [nr, nc] of neighbors) {
    if (board.flagged[nr][nc]) flagCount++;
  }
  if (flagCount !== number) return { changed: [], exploded: false, bonus: false };

  const changed = [];
  let exploded = false;
  let bonus = false;
  for (const [nr, nc] of neighbors) {
    if (board.flagged[nr][nc] || board.revealed[nr][nc]) continue;
    const result = revealCell(board, nr, nc);
    changed.push(...result.changed);
    if (result.bonus) bonus = true;
    if (result.exploded) {
      exploded = true;
      break; // a wrongly-flagged mine ends the attempt, same as a direct click on it
    }
  }
  return { changed, exploded, bonus };
}

// A board is cleared once every non-mine cell has been revealed - the
// standard Minesweeper win condition (mines never need flagging to win).
function checkWin(board) {
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      if (!board.isMine[r][c] && !board.revealed[r][c]) return false;
    }
  }
  return true;
}

const api = { DIFFICULTIES, mulberry32, generateBoard, revealCell, chordCell, toggleFlag, checkWin };

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.MinesweeperEngine = api;
}
