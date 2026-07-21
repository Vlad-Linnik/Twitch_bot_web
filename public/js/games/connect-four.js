// /games/connect-four - online 1v1 Connect Four via auto-matchmaking
// (realtime/quickMatchManager.js + lib/connectFourEngine.js). Server fully
// authoritative; this file only sends column-drop moves and renders whatever
// "state" push it receives.
(function () {
  "use strict";

  const root = document.getElementById("c4-root");
  if (!root || !window.createQuickMatchClient) return;

  const ROWS = 6;
  const COLS = 7; // must match lib/connectFourEngine.js

  const client = window.createQuickMatchClient(root.dataset.wsPath);
  window.wireQuickMatchQueueDisplay(client, {
    countEl: document.getElementById("c4-queue-count"),
    timeEl: document.getElementById("c4-queue-time"),
  });

  const screens = {
    idle: document.getElementById("c4-screen-idle"),
    queued: document.getElementById("c4-screen-queued"),
    game: document.getElementById("c4-screen-game"),
  };
  const boardEl = document.getElementById("c4-board");
  const statusEl = document.getElementById("c4-status");
  const opponentBanner = document.getElementById("c4-opponent-banner");
  const resultOverlay = document.getElementById("c4-result");
  const resultTitle = document.getElementById("c4-result-title");
  const resultBody = document.getElementById("c4-result-body");
  const timerEl = document.getElementById("c4-timer");
  const colorBadge = document.getElementById("c4-color-badge");

  // --- Sound (cloneNode()-per-play pattern shared with the other on-site
  // games, e.g. battleship.js, so it can't cut itself off on a fast rematch).
  const GAME_OVER_SOUND = new Audio("/sounds/games/connect-four/game-over.wav");
  GAME_OVER_SOUND.volume = 0.5;
  const DROP_SOUND = new Audio("/sounds/games/connect-four/drop.wav");
  DROP_SOUND.volume = 0.5;
  function playSound(base) {
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume;
      node.play().catch(() => {});
    } catch (_) {
      /* audio blocked/unsupported - the game keeps working silently */
    }
  }

  let youAreSeat = 0;
  let columnEls = [];
  let cellEls = [];
  // Previous grid, so render() can diff and only animate cells that just
  // filled - null means "no prior render this game" (buildBoard resets it),
  // which skips animation for a freshly-dealt/rejoined board.
  let lastGrid = null;
  // Row the local player actually clicked, per column - lets the drop
  // animation start from wherever they clicked instead of always flying in
  // from above the board (every cell in a column is clickable, not just the
  // top one). null for a column means "no local click pending" (opponent
  // moves, or a fresh state sync), which falls back to the top row - still
  // inside the board, never above/outside it.
  let lastClickedRow = new Array(COLS).fill(null);

  // Drop animation: the disc is already painted at its resting cell (color
  // class applied instantly, same as before) - this just slides it in from
  // the clicked row down to its resting row with the Web Animations API, so
  // the fall is visible instead of the disc teleporting straight there. That
  // visible fall is also what makes "gravity finishes the drop, it doesn't
  // just place the piece where you clicked" legible to a first-time player.
  // Falls straight through, ignored if unsupported.
  function animateDrop(el, targetRow, startRow) {
    if (!el.animate) return;
    const rows = Math.max(0, targetRow - startRow);
    if (rows === 0) return; // clicked (at/below) the resting cell - nothing to animate
    const rect = el.getBoundingClientRect();
    const cellSize = rect.height || rect.width;
    if (!cellSize) return;
    const gapPx = parseFloat(getComputedStyle(boardEl).rowGap) || 0;
    const startY = -rows * (cellSize + gapPx);
    try {
      el.animate([{ transform: "translateY(" + startY + "px)" }, { transform: "translateY(0)" }], {
        duration: 200 + rows * 25,
        easing: "cubic-bezier(0.55, 0, 1, 0.45)", // accelerating, gravity-like
      });
    } catch (_) {
      /* Web Animations API unsupported - disc still ends up in the right place */
    }
  }

  // --- Per-move countdown (server-authoritative deadline, same pattern as
  // battleship.js's phase timer - here there's only one deadline "kind" so
  // there's no label to switch on, just the mm:ss itself). ------------------
  let deadlineAt = null;
  let timerHandle = null;

  function renderTimer() {
    if (!timerEl) return;
    if (deadlineAt == null) {
      timerEl.hidden = true;
      return;
    }
    timerEl.hidden = false;
    const ms = Math.max(0, deadlineAt - Date.now());
    const total = Math.ceil(ms / 1000);
    timerEl.textContent = String(Math.floor(total / 60)) + ":" + String(total % 60).padStart(2, "0");
    timerEl.classList.toggle("bs-timer-urgent", ms < 10000);
  }

  function setDeadline(d) {
    deadlineAt = d ? d.at : null;
    if (!d && timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    renderTimer();
    if (d && !timerHandle) timerHandle = setInterval(renderTimer, 250);
  }

  function showScreen(name) {
    for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  }

  function buildBoard() {
    boardEl.textContent = "";
    boardEl.style.gridTemplateColumns = "repeat(" + COLS + ", minmax(0, 1fr))";
    lastGrid = null;
    lastClickedRow = new Array(COLS).fill(null);
    columnEls = [];
    cellEls = Array.from({ length: ROWS }, () => new Array(COLS));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "c4-cell";
        el.addEventListener("click", () => {
          lastClickedRow[c] = r;
          client.send("move", { move: { col: c } });
        });
        cellEls[r][c] = el;
        boardEl.appendChild(el);
      }
    }
  }

  function render(state) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const val = state.grid[r][c];
        let cls = "c4-cell";
        if (val === 0) cls += " c4-cell-p0";
        else if (val === 1) cls += " c4-cell-p1";
        const el = cellEls[r][c];
        el.className = cls;
        if (lastGrid && val !== null && lastGrid[r][c] === null) {
          const startRow = lastClickedRow[c] != null ? lastClickedRow[c] : 0;
          lastClickedRow[c] = null;
          animateDrop(el, r, startRow);
          playSound(DROP_SOUND);
        }
      }
    }
    lastGrid = state.grid;
    if (state.winnerSeat != null || state.draw) return;
    statusEl.textContent = state.turnSeat === youAreSeat ? statusEl.dataset.yourTurn : statusEl.dataset.opponentTurn;
  }

  client.on("matched", (msg) => {
    youAreSeat = msg.youAreSeat;
    showScreen("game");
    resultOverlay.hidden = true;
    opponentBanner.hidden = true;
    buildBoard();
    if (colorBadge) {
      colorBadge.hidden = false;
      colorBadge.textContent = youAreSeat === 0 ? colorBadge.dataset.p0 : colorBadge.dataset.p1;
      colorBadge.className = "c4-color-badge " + (youAreSeat === 0 ? "c4-color-badge-p0" : "c4-color-badge-p1");
    }
    setDeadline(msg.deadline);
  });

  client.on("state", (msg) => {
    setDeadline(msg.deadline);
    render(msg.state);
  });

  client.on("gameOver", (msg) => {
    setDeadline(null);
    playSound(GAME_OVER_SOUND);
    let titleKey;
    if (msg.result === "draw") titleKey = "draw";
    else titleKey = msg.winnerSeat === youAreSeat ? "win" : "lose";
    resultTitle.textContent = resultTitle.dataset[titleKey];
    resultBody.textContent =
      typeof msg.ratingDelta === "number"
        ? resultBody.dataset.ratingTpl.replace("{{delta}}", (msg.ratingDelta >= 0 ? "+" : "") + msg.ratingDelta)
        : "";
    resultOverlay.hidden = false;
  });

  client.on("opponentDisconnected", () => {
    opponentBanner.hidden = false;
  });
  client.on("opponentReconnected", () => {
    opponentBanner.hidden = true;
  });
  client.on("error", (msg) => console.error("[connect-four] server error:", msg.error));

  document.getElementById("c4-queue-button")?.addEventListener("click", () => {
    showScreen("queued");
    client.send("queue");
  });
  document.getElementById("c4-cancel-queue")?.addEventListener("click", () => {
    client.send("cancelQueue");
    showScreen("idle");
  });
  document.getElementById("c4-resign")?.addEventListener("click", () => {
    client.send("resign");
  });
  document.getElementById("c4-play-again")?.addEventListener("click", () => {
    showScreen("idle");
  });

  // Ready-check popup (shared partial + shared wiring). matchCancelled drops to
  // idle; queued (a re-queue after a cancel) shows the searching screen again.
  window.wireQuickMatchReadyCheck(client);
  client.on("matchCancelled", () => showScreen("idle"));
  client.on("queued", () => showScreen("queued"));

  showScreen("idle");
  client.connect();
})();
