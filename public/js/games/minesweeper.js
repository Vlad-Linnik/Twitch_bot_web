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
    if (state !== "running") return;
    // Clicking an already-revealed number chords: if its surrounding flags
    // already match its count, reveal the rest of its neighbors in one go.
    const result = board.revealed[r][c] ? engine.chordCell(board, r, c) : engine.revealCell(board, r, c);
    for (const [cr, cc] of result.changed) renderCell(cr, cc);
    if (result.exploded) {
      // This board's attempt ends without counting toward boardsCleared, but
      // the run continues - reveal the rest of the mines for feedback, then
      // deal a fresh board.
      playSound("explosion");
      revealAllMines();
      setTimeout(nextBoard, 400);
      return;
    }
    if (result.bonus && bonusProcs < BONUS_MAX_PROCS) {
      bonusProcs++;
      deadline += BONUS_MS;
      showBonusToast();
    }
    updateMinesLeft();
    if (engine.checkWin(board)) {
      boardsCleared++;
      boardsEl.textContent = boardsCleared;
      setTimeout(nextBoard, 250);
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
    if (state !== "running") return;
    const placed = engine.toggleFlag(board, r, c);
    if (placed) playSound("flag");
    renderCell(r, c);
    updateMinesLeft();
  }

  function nextBoard() {
    if (state !== "running") return;
    // The engine's "first click is safe" guarantee needs a designated safe
    // cell up front - the board's own center is a reasonable choice since
    // the player hasn't clicked yet on a fresh board.
    const diff = engine.DIFFICULTIES[DIFFICULTY_KEY];
    board = engine.generateBoard(DIFFICULTY_KEY, Math.floor(diff.rows / 2), Math.floor(diff.cols / 2), Math.random);
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

  function startRun() {
    boardsCleared = 0;
    bonusProcs = 0;
    boardsEl.textContent = "0";
    deadline = Date.now() + RUN_MS;
    state = "running";
    hideOverlay();
    nextBoard();
    tick();
    tickHandle = setInterval(tick, 250);
  }

  function endRun() {
    state = "over";
    clearInterval(tickHandle);
    tickHandle = null;
    submitScore(boardsCleared);
    showOverlay("over");
  }

  // --- Leaderboard -----------------------------------------------------------
  // Same wiring as 2048.js/falling-blocks.js - see those files' comments.

  const leaderboard = document.getElementById("ms-leaderboard");
  const lbList = document.getElementById("ms-lb-list");
  const lbMeWrap = document.getElementById("ms-lb-me");
  const lbMeRow = document.getElementById("ms-lb-me-row");

  function lbRow(row, isMe) {
    const li = document.createElement("li");
    li.className = "flex items-baseline gap-2 text-sm py-1 px-1 rounded" + (isMe ? " bg-purple-500/10" : "");
    const rank = document.createElement("span");
    rank.className = "w-5 text-right tabular-nums text-neutral-500 shrink-0";
    rank.textContent = row.rank;
    const name = document.createElement("span");
    name.className = "flex-1 truncate " + (isMe ? "text-purple-300" : "text-neutral-300");
    name.textContent = row.displayName;
    if (row.color) name.style.color = row.color;
    const points = document.createElement("span");
    points.className = "tabular-nums text-neutral-100";
    points.textContent = row.score;
    li.append(rank, name, points);
    return li;
  }

  function renderLeaderboard(data) {
    lbList.textContent = "";
    if (data.rows.length === 0) {
      const li = document.createElement("li");
      li.className = "text-sm text-neutral-500 py-1";
      li.textContent = leaderboard.dataset.emptyLabel;
      lbList.appendChild(li);
    }
    for (const row of data.rows) lbList.appendChild(lbRow(row, row.isMe));
    lbMeRow.textContent = "";
    if (data.myRow) {
      lbMeRow.appendChild(lbRow(data.myRow, true));
      lbMeWrap.hidden = false;
    } else {
      lbMeWrap.hidden = true;
    }
  }

  function submitScore(finalScore) {
    if (!leaderboard || !leaderboard.dataset.submitUrl || finalScore < 1) return;
    fetch(leaderboard.dataset.submitUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: leaderboard.dataset.csrf, score: String(finalScore) }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && data.ok) renderLeaderboard(data);
      })
      .catch(() => {});
  }

  // --- Leave-page confirmation -------------------------------------------------

  function gameInProgress() {
    return state === "running";
  }

  function saveScoreBeacon() {
    if (!leaderboard || !leaderboard.dataset.submitUrl || boardsCleared < 1) return;
    fetch(leaderboard.dataset.submitUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: leaderboard.dataset.csrf, score: String(boardsCleared) }),
      keepalive: true,
    }).catch(() => {});
  }

  const leaveDialog = document.getElementById("ms-leave-confirm-dialog");
  const leaveSaveBtn = document.getElementById("ms-leave-save");
  const leaveDiscardBtn = document.getElementById("ms-leave-discard");
  const leaveCancelBtn = document.getElementById("ms-leave-cancel");
  let pendingLeaveHref = null;

  if (leaveDialog) {
    document.addEventListener("click", (event) => {
      if (!gameInProgress()) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest("a[href]");
      if (!link || link.target === "_blank") return;
      event.preventDefault();
      pendingLeaveHref = link.href;
      if (leaveSaveBtn) leaveSaveBtn.hidden = !(leaderboard && leaderboard.dataset.submitUrl);
      leaveDialog.showModal();
    });

    leaveCancelBtn?.addEventListener("click", () => leaveDialog.close());
    leaveDiscardBtn?.addEventListener("click", () => {
      clearInterval(tickHandle);
      leaveDialog.close();
      if (pendingLeaveHref) location.href = pendingLeaveHref;
    });
    leaveSaveBtn?.addEventListener("click", () => {
      saveScoreBeacon();
      clearInterval(tickHandle);
      leaveDialog.close();
      if (pendingLeaveHref) location.href = pendingLeaveHref;
    });
  }

  window.addEventListener("beforeunload", (event) => {
    if (!gameInProgress()) return;
    event.preventDefault();
    event.returnValue = "";
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

  showOverlay("start");
})();
