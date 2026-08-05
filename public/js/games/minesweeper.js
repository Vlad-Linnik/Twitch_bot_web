// /games/minesweeper - a timed Minesweeper marathon on a single fixed
// Beginner (9x9) board. The player has 5 minutes to clear as many boards as
// they can - the leaderboard/final-score value is simply the count of
// cleared boards (there's only one difficulty now, so a separate points
// system doesn't add anything). Hitting a mine ends only that board's
// attempt - a fresh board starts immediately, same as a clear. Boards
// occasionally hide one bonus cell that grants +10s when safely revealed,
// capped at 6 procs/+60s per run so a lucky run can't run forever.
//
// Board logic lives in engines/minesweeperEngine.js (loaded via <script> tag
// before this file - see gameMinesweeper.ejs) so it's shared with the
// node:test suite. This file owns only the timer/session/score loop and DOM
// rendering, same split as 2048.js owning its own movement logic locally
// (there the pure logic never needed sharing with a test file).
(function () {
  "use strict";

  const engine = window.MinesweeperEngine;
  const root = document.getElementById("ms-board");
  if (!root || !engine) return;

  const RUN_MS = 5 * 60 * 1000;
  const BONUS_MS = 10 * 1000;
  const BONUS_MAX_PROCS = 6;
  const DIFFICULTY_KEY = "beginner";

  // Anti-cheat: the run's inputs are recorded and re-simulated server-side
  // (lib/gameReplay/minesweeper.js). Bump RULES_VERSION here AND there
  // together whenever a gameplay constant above changes - a mismatch makes the
  // server skip verification rather than mis-score an honest run.
  const RULES_VERSION = 2;
  const OP_REVEAL = 0;
  const OP_FLAG = 1;

  const run = window.SoloRun.create({
    gameKey: "minesweeper",
    rulesVersion: RULES_VERSION,
    rootId: "ms-leaderboard",
    listId: "ms-lb-list",
    meWrapId: "ms-lb-me",
    meRowId: "ms-lb-me-row",
  });

  const boardsEl = document.getElementById("ms-boards");
  const timeEl = document.getElementById("ms-time");
  const minesLeftEl = document.getElementById("ms-mines-left");
  const bonusToast = document.getElementById("ms-bonus-toast");

  const overlay = document.getElementById("ms-overlay");
  const overlayTitle = document.getElementById("ms-overlay-title");
  const overlayScore = document.getElementById("ms-overlay-score");
  const overlayButton = document.getElementById("ms-overlay-button");

  // --- Sound ---------------------------------------------------------------
  // Same clone-and-play pattern as pipe-dodger.js's playSound(), so
  // overlapping triggers (e.g. chording through several mines) don't cut
  // each other off.
  const SOUND_BASE = "/sounds/games/minesweeper/";
  const SOUNDS = {
    explosion: new Audio(SOUND_BASE + "explosion.wav"),
    flag: new Audio(SOUND_BASE + "flag.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

  function playSound(name) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume * (window.gameVolume ? window.gameVolume.get() : 1);
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

  let board = null;
  let boardsCleared = 0;
  let bonusProcs = 0;
  let deadline = 0;
  let tickHandle = null;
  let state = "idle"; // idle | running | over
  let cellEls = null;
  // Bumped by startRun() - state alone can't tell a fresh run from an abandoned one (both are
  // "running"), so a deferred setTimeout(nextBoard, ...) still pending from a board cleared/lost
  // right before the restart button fired would otherwise swap out the just-started board too.
  let runToken = 0;
  // Guards startRun() against re-entry: runToken above protects a board
  // already dealt from a stray deferred swap, but it can't stop two clicks
  // that both land while the first is still awaiting run.begin() - both
  // would otherwise proceed to deal their own board on their own timer.
  let starting = false;
  // Set the moment a board is finished (cleared or exploded) and cleared again
  // by nextBoard(). The swap is deferred 250/400ms so the player can see the
  // result, and without this the finished board stays clickable during that
  // window - which meant every extra click on an already-cleared board passed
  // checkWin() again and scored ANOTHER board. Rapid-clicking after a clear
  // was worth several free points.
  let boardDone = false;

  function fmtTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function cellClass(r, c) {
    if (!board.revealed[r][c]) {
      return board.flagged[r][c]
        ? "ms-cell ms-cell-flag"
        : "ms-cell ms-cell-hidden";
    }
    if (board.isMine[r][c]) return "ms-cell ms-cell-mine";
    return "ms-cell ms-cell-revealed";
  }

  const NUMBER_COLORS = [
    "", // 0 has no label
    "text-sky-400",
    "text-emerald-400",
    "text-rose-400",
    "text-violet-400",
    "text-amber-500",
    "text-teal-400",
    "text-neutral-200",
    "text-neutral-400",
  ];

  function renderCell(r, c) {
    const el = cellEls[r][c];
    el.className = cellClass(r, c);
    if (board.revealed[r][c] && !board.isMine[r][c]) {
      const n = board.adjacency[r][c];
      el.textContent = n > 0 ? String(n) : "";
      el.style.color = "";
      if (n > 0) el.classList.add(NUMBER_COLORS[n]);
    } else if (board.revealed[r][c] && board.isMine[r][c]) {
      el.textContent = "\u{1F4A3}"; // 💣
    } else if (board.flagged[r][c]) {
      el.textContent = "\u{1F6A9}"; // 🚩
    } else {
      el.textContent = "";
    }
  }

  function renderAll() {
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) renderCell(r, c);
    }
    updateMinesLeft();
  }

  function updateMinesLeft() {
    const diff = engine.DIFFICULTIES[DIFFICULTY_KEY];
    let flagged = 0;
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (board.flagged[r][c]) flagged++;
      }
    }
    minesLeftEl.textContent = Math.max(0, diff.mines - flagged);
  }

  function buildBoardDom() {
    root.textContent = "";
    root.style.gridTemplateColumns = "repeat(" + board.cols + ", minmax(0, 1fr))";
    root.style.aspectRatio = board.cols + " / " + board.rows;
    cellEls = Array.from({ length: board.rows }, () => new Array(board.cols));
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = cellClass(r, c);
        el.addEventListener("click", () => handleReveal(r, c));
        el.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          handleFlag(r, c);
        });
        cellEls[r][c] = el;
        root.appendChild(el);
      }
    }
    updateCellFont();
  }

  // Ties cell text size to the actual rendered cell width instead of the CSS
  // clamp's viewport-relative fallback - see input.css's .ms-cell comment for
  // why that broke Expert's 30-column grid.
  const BOARD_GAP_PX = 2; // matches #ms-board's gap-[2px]
  function updateCellFont() {
    if (!board) return;
    const boardWidth = root.getBoundingClientRect().width;
    if (boardWidth <= 0) return;
    const cellPx = (boardWidth - BOARD_GAP_PX * (board.cols - 1)) / board.cols;
    const fontPx = Math.max(7, Math.min(16, cellPx * 0.5));
    root.style.setProperty("--ms-cell-font", fontPx.toFixed(2) + "px");
  }

  let resizeQueued = false;
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      updateCellFont();
    });
  });

  // Retriggers a CSS animation on `el` by toggling its class off then back on
  // (a bare classList.add() is a no-op if the class - and thus the
  // animation - is already present, e.g. two bonuses found back to back).
  function popClass(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function showBonusToast() {
    popClass(bonusToast, "ms-bonus-pop");
    popClass(timeEl, "ms-time-pop");
    // The bonus cell itself flashes too, so it's clear *which* cell granted
    // the extra time - a plain reveal looks identical to any other cell
    // otherwise.
    if (board.bonus) popClass(cellEls[board.bonus.r][board.bonus.c], "ms-cell-bonus-pop");
  }

  function handleReveal(r, c) {
    if (state !== "running" || boardDone) return;
    run.record(OP_REVEAL, r * board.cols + c);
    // The board isn't dealt until this, its first reveal - THIS cell is the
    // safe one, not some pre-guessed spot, so the very first click can never
    // be a mine no matter where the player clicks. Any flags placed on the
    // shell beforehand carry over onto the real board.
    if (!board.generated) {
      const flagged = board.flagged;
      board = engine.generateBoard(DIFFICULTY_KEY, r, c, run.rng);
      board.flagged = flagged;
    }
    // Clicking an already-revealed number chords: if its surrounding flags
    // already match its count, reveal the rest of its neighbors in one go.
    const result = board.revealed[r][c] ? engine.chordCell(board, r, c) : engine.revealCell(board, r, c);
    for (const [cr, cc] of result.changed) renderCell(cr, cc);
    if (result.exploded) {
      // This board's attempt ends without counting toward boardsCleared, but
      // the run continues - reveal the rest of the mines for feedback, then
      // deal a fresh board.
      playSound("explosion");
      boardDone = true;
      revealAllMines();
      const explodedToken = runToken;
      setTimeout(() => {
        if (explodedToken === runToken) nextBoard();
      }, 400);
      return;
    }
    if (result.bonus && bonusProcs < BONUS_MAX_PROCS) {
      bonusProcs++;
      deadline += BONUS_MS;
      showBonusToast();
    }
    updateMinesLeft();
    if (engine.checkWin(board)) {
      boardDone = true;
      boardsCleared++;
      boardsEl.textContent = boardsCleared;
      const clearedToken = runToken;
      setTimeout(() => {
        if (clearedToken === runToken) nextBoard();
      }, 250);
    }
  }

  function revealAllMines() {
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (board.isMine[r][c]) {
          board.revealed[r][c] = true;
          renderCell(r, c);
        }
      }
    }
  }

  function handleFlag(r, c) {
    if (state !== "running" || boardDone) return;
    // Flags score nothing but they gate chording, so the server has to see
    // them to replay the run faithfully.
    run.record(OP_FLAG, r * board.cols + c);
    const placed = engine.toggleFlag(board, r, c);
    if (placed) playSound("flag");
    renderCell(r, c);
    updateMinesLeft();
  }

  function nextBoard() {
    if (state !== "running") return;
    boardDone = false;
    // No mines yet - an empty shell so the board can be shown (and flagged)
    // immediately. The real board isn't dealt until handleReveal()'s first
    // click, using that click's own cell as the safe one (standard
    // Minesweeper: the first click is never a mine, wherever it lands).
    // run.rng is the SERVER's seed for this run (or Math.random when the run
    // couldn't be registered). One rng for the whole run, never one per board:
    // generateBoard consumes a data-dependent number of draws, so only a
    // continuous stream stays in step with the server's replay.
    board = engine.createShell(DIFFICULTY_KEY);
    buildBoardDom();
    renderAll();
  }

  function tick() {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timeEl.textContent = "0:00";
      endRun();
      return;
    }
    timeEl.textContent = fmtTime(remaining);
  }

  async function startRun() {
    if (starting) return;
    starting = true;
    try {
      if (tickHandle) clearInterval(tickHandle); // safe to call while already running (the restart button)
      runToken++; // invalidate any deferred nextBoard() still pending from the abandoned run
      boardsCleared = 0;
      bonusProcs = 0;
      boardsEl.textContent = "0";
      // Register the run first: nextBoard() below needs the server's seed, and
      // the clock must not start until we have it. begin() races itself against
      // a short timeout and resolves either way, so a slow or unreachable server
      // costs a moment, never the ability to play (the run is then unranked).
      await run.begin();
      deadline = Date.now() + RUN_MS;
      state = "running";
      hideOverlay();
      nextBoard();
      tick();
      tickHandle = setInterval(tick, 250);
    } finally {
      starting = false;
    }
  }

  function endRun() {
    state = "over";
    clearInterval(tickHandle);
    tickHandle = null;
    run.finish(boardsCleared);
    showOverlay("over");
  }

  // --- Leaderboard / leave-page confirmation ---------------------------------
  // Both used to be copy-pasted into each of the six solo games; they now live
  // in soloRunClient.js, which also owns the run token and input recording.

  function gameInProgress() {
    return state === "running";
  }

  window.SoloRun.wireLeaveConfirm({
    dialogId: "ms-leave-confirm-dialog",
    saveId: "ms-leave-save",
    discardId: "ms-leave-discard",
    cancelId: "ms-leave-cancel",
    isInProgress: gameInProgress,
    canSave: () => run.canSubmit(),
    onDiscard: () => clearInterval(tickHandle),
    onSave: () => {
      run.leaveBeacon(boardsCleared);
      clearInterval(tickHandle);
    },
  });

  // --- Overlay -----------------------------------------------------------

  function showOverlay(kind) {
    const d = overlay.dataset;
    overlayScore.hidden = kind !== "over";
    if (kind === "start") {
      overlayTitle.textContent = d.titleStart;
      overlayButton.textContent = d.buttonStart;
    } else {
      overlayTitle.textContent = d.titleOver;
      overlayScore.textContent = d.boardsLabel + ": " + boardsCleared;
      overlayButton.textContent = d.buttonAgain;
    }
    overlay.style.display = "";
  }

  function hideOverlay() {
    overlay.style.display = "none";
  }

  overlayButton.addEventListener("click", () => {
    startRun();
    overlayButton.blur();
  });

  const restartBtn = document.getElementById("ms-restart");
  restartBtn?.addEventListener("click", () => {
    startRun();
    restartBtn.blur();
  });

  showOverlay("start");
})();
