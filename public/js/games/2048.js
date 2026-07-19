// /games/2048 - a fully client-side sliding-tile puzzle. Unlike the canvas-based
// falling-blocks/pipe-dodger games, the board is plain DOM: each tile is an
// absolutely positioned element inside #g2048-tiles, moved via percentage-based
// left/top (CSS transition), which scales responsively without any
// devicePixelRatio math. No server state beyond the best score behind the
// leaderboard (db/gameScoresRepo.js, web-only database) - same leaderboard/
// leave-confirm/beforeunload wiring as the other two games, copied near-verbatim.
(function () {
  "use strict";

  const board = document.getElementById("g2048-board");
  if (!board) return;

  const SIZE = 4;
  const WIN_VALUE = 2048;
  const BEST_KEY = "the2048Best";
  const MOVE_MS = 120;
  const SPAWN_MS = 160;

  const scoreEl = document.getElementById("g2048-score");
  const bestEl = document.getElementById("g2048-best");
  const cellsLayer = document.getElementById("g2048-cells");
  const tilesLayer = document.getElementById("g2048-tiles");

  const overlay = document.getElementById("g2048-overlay");
  const overlayTitle = document.getElementById("g2048-overlay-title");
  const overlayScore = document.getElementById("g2048-overlay-score");
  const overlayButton = document.getElementById("g2048-overlay-button");
  const overlayHint = document.getElementById("g2048-overlay-hint");

  function readBest() {
    try {
      return parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  function writeBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch (_) {
      /* private mode etc. - the game just won't remember the record */
    }
  }

  // --- Static background grid -------------------------------------------------

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement("div");
      cell.className = "absolute rounded-md bg-neutral-800/40";
      cell.style.left = c * 25 + "%";
      cell.style.top = r * 25 + "%";
      cell.style.width = "25%";
      cell.style.height = "25%";
      const inner = document.createElement("div");
      inner.className = "absolute inset-[4%] rounded-md bg-neutral-800/40";
      cell.appendChild(inner);
      cellsLayer.appendChild(cell);
    }
  }

  // --- Tile visuals ------------------------------------------------------------

  const TILE_STYLES = {
    2: "bg-neutral-200 text-neutral-900",
    4: "bg-neutral-300 text-neutral-900",
    8: "bg-sky-400 text-neutral-900",
    16: "bg-sky-500 text-white",
    32: "bg-blue-500 text-white",
    64: "bg-blue-600 text-white",
    128: "bg-violet-500 text-white",
    256: "bg-violet-600 text-white",
    512: "bg-purple-500 text-white",
    1024: "bg-purple-600 text-white",
    2048: "bg-amber-400 text-neutral-900",
  };

  function styleFor(value) {
    return TILE_STYLES[value] || "bg-rose-600 text-white";
  }

  function fontSizeFor(value) {
    if (value >= 1000) return "text-lg sm:text-xl";
    if (value >= 100) return "text-xl sm:text-2xl";
    return "text-2xl sm:text-3xl";
  }

  function applyTileStyle(inner, value) {
    inner.className =
      "g2048-tile-inner absolute inset-[4%] rounded-md grid place-items-center font-bold " +
      styleFor(value) +
      " " +
      fontSizeFor(value);
    inner.textContent = value;
  }

  function setTilePos(el, r, c) {
    if (!el) return;
    el.style.left = c * 25 + "%";
    el.style.top = r * 25 + "%";
  }

  function retriggerAnim(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow, so re-adding the class replays the animation
    el.classList.add(cls);
  }

  function createTileEl(tile) {
    const pos = document.createElement("div");
    pos.className = "g2048-tile-pos absolute";
    pos.style.width = "25%";
    pos.style.height = "25%";
    setTilePos(pos, tile.r, tile.c);
    const inner = document.createElement("div");
    applyTileStyle(inner, tile.value);
    inner.classList.add("g2048-spawn");
    pos.appendChild(inner);
    tilesLayer.appendChild(pos);
    tileEls.set(tile.id, pos);
  }

  // --- Game state --------------------------------------------------------------

  let cells; // cells[r][c] = tile object or null
  let tiles; // Map id -> tile object {id, r, c, value}
  let tileEls; // Map id -> outer positioned element
  let nextId;
  let score, best;
  let won = false;
  let busy = false;
  let state = "idle"; // idle | running | won | over

  function emptyCells() {
    const res = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!cells[r][c]) res.push([r, c]);
      }
    }
    return res;
  }

  function spawnRandomTile() {
    const empties = emptyCells();
    if (empties.length === 0) return null;
    const [r, c] = empties[Math.floor(Math.random() * empties.length)];
    const value = Math.random() < 0.9 ? 2 : 4;
    const tile = { id: nextId++, r, c, value };
    cells[r][c] = tile;
    tiles.set(tile.id, tile);
    createTileEl(tile);
    return tile;
  }

  function reset() {
    cells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    tiles = new Map();
    tileEls = new Map();
    tilesLayer.textContent = "";
    nextId = 1;
    score = 0;
    won = false;
    busy = false;
    spawnRandomTile();
    spawnRandomTile();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
  }

  // --- Movement ------------------------------------------------------------

  // Each line is 4 [r,c] coordinate pairs ordered toward index 0, i.e. the
  // direction tiles slide toward for that move.
  function linesFor(dir) {
    const lines = [];
    if (dir === "left" || dir === "right") {
      for (let r = 0; r < SIZE; r++) {
        const cols = [0, 1, 2, 3];
        if (dir === "right") cols.reverse();
        lines.push(cols.map((c) => [r, c]));
      }
    } else {
      for (let c = 0; c < SIZE; c++) {
        const rows = [0, 1, 2, 3];
        if (dir === "down") rows.reverse();
        lines.push(rows.map((r) => [r, c]));
      }
    }
    return lines;
  }

  function move(dir) {
    if (state !== "running" || busy) return;

    const lines = linesFor(dir);
    const newCells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    const merges = []; // {primary, secondary, r, c, value}
    let moved = false;
    let scoreGain = 0;

    for (const line of lines) {
      const seq = [];
      for (const [r, c] of line) {
        const t = cells[r][c];
        if (t) seq.push(t);
      }
      let i = 0;
      let slot = 0;
      while (i < seq.length) {
        const [r, c] = line[slot];
        const cur = seq[i];
        if (i + 1 < seq.length && seq[i + 1].value === cur.value) {
          const secondary = seq[i + 1];
          const value = cur.value * 2;
          scoreGain += value;
          merges.push({ primary: cur, secondary, r, c, value });
          cur.r = r;
          cur.c = c;
          cur.value = value;
          newCells[r][c] = cur;
          tiles.delete(secondary.id);
          moved = true;
          i += 2;
        } else {
          if (cur.r !== r || cur.c !== c) moved = true;
          cur.r = r;
          cur.c = c;
          newCells[r][c] = cur;
          i += 1;
        }
        slot++;
      }
    }

    if (!moved) return;

    cells = newCells;
    score += scoreGain;
    busy = true;
    updateHud();

    // Slide phase: every surviving tile (and merge-losers, which slide onto
    // their partner's cell before being removed) moves to its new position now.
    for (const tile of tiles.values()) setTilePos(tileEls.get(tile.id), tile.r, tile.c);
    for (const mg of merges) setTilePos(tileEls.get(mg.secondary.id), mg.r, mg.c);

    setTimeout(() => {
      for (const mg of merges) {
        const secEl = tileEls.get(mg.secondary.id);
        if (secEl) secEl.remove();
        tileEls.delete(mg.secondary.id);
        const primEl = tileEls.get(mg.primary.id);
        if (primEl) {
          applyTileStyle(primEl.firstElementChild, mg.value);
          retriggerAnim(primEl.firstElementChild, "g2048-merge");
        }
      }

      spawnRandomTile();

      setTimeout(() => {
        busy = false;
        checkWinAndOver();
      }, SPAWN_MS);
    }, MOVE_MS);
  }

  function hasReachedWinValue() {
    for (const tile of tiles.values()) {
      if (tile.value >= WIN_VALUE) return true;
    }
    return false;
  }

  function isGameOver() {
    if (emptyCells().length > 0) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = cells[r][c].value;
        if (c + 1 < SIZE && cells[r][c + 1].value === v) return false;
        if (r + 1 < SIZE && cells[r + 1][c].value === v) return false;
      }
    }
    return true;
  }

  function checkWinAndOver() {
    if (!won && hasReachedWinValue()) {
      won = true;
      state = "won";
      showOverlay("won");
      return;
    }
    if (isGameOver()) endGame();
  }

  function endGame() {
    state = "over";
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    submitScore(score);
    showOverlay("over");
  }

  // --- Leaderboard -----------------------------------------------------------
  // Identical wiring to the other two games' leaderboard sections - keep all
  // three in sync if the shared markup/response shape ever changes.

  const leaderboard = document.getElementById("g2048-leaderboard");
  const lbList = document.getElementById("g2048-lb-list");
  const lbMeWrap = document.getElementById("g2048-lb-me");
  const lbMeRow = document.getElementById("g2048-lb-me-row");

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

  // Fire-and-forget: the leaderboard is a side dish, a failed save must never
  // interrupt the game. Anonymous visitors have no data-csrf (the server
  // wouldn't accept their score anyway), so we don't even attempt the POST.
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
    return state === "running" || state === "won";
  }

  function saveScoreBeacon() {
    if (!leaderboard || !leaderboard.dataset.submitUrl || score < 1) return;
    fetch(leaderboard.dataset.submitUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: leaderboard.dataset.csrf, score: String(score) }),
      keepalive: true,
    }).catch(() => {});
  }

  const leaveDialog = document.getElementById("g2048-leave-confirm-dialog");
  const leaveSaveBtn = document.getElementById("g2048-leave-save");
  const leaveDiscardBtn = document.getElementById("g2048-leave-discard");
  const leaveCancelBtn = document.getElementById("g2048-leave-cancel");
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
      leaveDialog.close();
      if (pendingLeaveHref) location.href = pendingLeaveHref;
    });
    leaveSaveBtn?.addEventListener("click", () => {
      saveScoreBeacon();
      leaveDialog.close();
      if (pendingLeaveHref) location.href = pendingLeaveHref;
    });
  }

  window.addEventListener("beforeunload", (event) => {
    if (!gameInProgress()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // --- Overlay / state transitions ------------------------------------------

  function showOverlay(kind) {
    const d = overlay.dataset;
    overlayScore.hidden = kind !== "over";
    overlayHint.textContent = kind === "start" ? d.hint : "";
    if (kind === "start") {
      overlayTitle.textContent = d.titleStart;
      overlayButton.textContent = d.buttonStart;
    } else if (kind === "won") {
      overlayTitle.textContent = d.titleWon;
      overlayButton.textContent = d.buttonKeepPlaying;
    } else {
      overlayTitle.textContent = d.titleOver;
      overlayScore.textContent = d.finalScoreLabel + ": " + score;
      overlayButton.textContent = d.buttonAgain;
    }
    overlay.style.display = "";
  }

  function hideOverlay() {
    overlay.style.display = "none";
  }

  function start() {
    reset();
    state = "running";
    hideOverlay();
  }

  overlayButton.addEventListener("click", () => {
    if (state === "won") {
      state = "running";
      hideOverlay();
    } else {
      start();
    }
    overlayButton.blur();
  });

  const newGameBtn = document.getElementById("g2048-newgame");
  newGameBtn?.addEventListener("click", () => {
    start();
    newGameBtn.blur();
  });

  // --- Input -----------------------------------------------------------------

  const DIR = {
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    ArrowUp: "up",
    KeyW: "up",
    ArrowDown: "down",
    KeyS: "down",
  };

  document.addEventListener("keydown", (event) => {
    const dir = DIR[event.code];
    if (!dir || state !== "running") return;
    event.preventDefault();
    move(dir);
  });

  let touchStartX = null;
  let touchStartY = null;
  const SWIPE_THRESHOLD = 24;

  board.addEventListener("pointerdown", (event) => {
    touchStartX = event.clientX;
    touchStartY = event.clientY;
  });

  board.addEventListener("pointerup", (event) => {
    if (touchStartX === null) return;
    const dx = event.clientX - touchStartX;
    const dy = event.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (state !== "running") return;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < SWIPE_THRESHOLD) return;
    if (absX > absY) move(dx > 0 ? "right" : "left");
    else move(dy > 0 ? "down" : "up");
  });

  // --- Boot --------------------------------------------------------------------

  best = readBest();
  reset();
  showOverlay("start");
})();
