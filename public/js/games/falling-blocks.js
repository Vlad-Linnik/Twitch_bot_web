// /games/falling-blocks - a fully client-side falling-blocks puzzle. No server
// state: the only thing persisted is the best score, in localStorage. All
// user-visible text is server-rendered in gameFallingBlocks.ejs (the overlay
// reads its labels from data-* attributes there) so i18n stays in one place.
(function () {
  "use strict";

  const board = document.getElementById("fb-board");
  if (!board) return;

  const COLS = 12;
  const ROWS = 20;
  const CELL = 30;
  const NEXT_CELL = 24;
  const BEST_KEY = "fallingBlocksBest";

  // Seven one-sided tetrominoes - the shapes themselves are game mechanics
  // (public domain); names, colors and rendering here are our own. Colors are
  // the Tailwind 400-series hues the rest of the site already uses.
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

  const ctx = board.getContext("2d");
  const nextCanvas = document.getElementById("fb-next");
  const nextCtx = nextCanvas.getContext("2d");

  const scoreEl = document.getElementById("fb-score");
  const bestEl = document.getElementById("fb-best");
  const linesEl = document.getElementById("fb-lines");
  const levelEl = document.getElementById("fb-level");

  const overlay = document.getElementById("fb-overlay");
  const overlayTitle = document.getElementById("fb-overlay-title");
  const overlayScore = document.getElementById("fb-overlay-score");
  const overlayButton = document.getElementById("fb-overlay-button");

  // Crisp rendering on high-DPI screens: scale the backing store, keep the CSS size.
  function scaleForDpr(canvas, context) {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === 1) return;
    const w = canvas.width;
    const h = canvas.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    context.scale(dpr, dpr);
  }
  scaleForDpr(board, ctx);
  scaleForDpr(nextCanvas, nextCtx);

  let grid, current, next, bag;
  let score, lines, level, best;
  let dropTimer, dropInterval;
  let state = "idle"; // idle | running | paused | over
  let rafId = null;
  let lastTime = 0;

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

  // --- Piece helpers -------------------------------------------------------

  // 7-bag randomizer: every piece appears once per bag, so droughts are bounded.
  function nextFromBag() {
    if (!bag || bag.length === 0) {
      bag = [0, 1, 2, 3, 4, 5, 6];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    const type = bag.pop();
    const def = PIECES[type];
    return {
      color: def.color,
      size: def.size,
      cells: def.cells.map((c) => c.slice()),
      x: Math.floor((COLS - def.size) / 2),
      y: 0,
    };
  }

  function collides(piece, dx, dy, cells) {
    const shape = cells || piece.cells;
    for (const [cx, cy] of shape) {
      const x = piece.x + cx + dx;
      const y = piece.y + cy + dy;
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && grid[y][x]) return true;
    }
    return false;
  }

  function rotatedCells(piece) {
    // Clockwise rotation inside the piece's own size×size box.
    return piece.cells.map(([x, y]) => [piece.size - 1 - y, x]);
  }

  function tryRotate() {
    // (The square rotates onto itself - its cells sit centered in the 4-box -
    // so no special case is needed.)
    const cells = rotatedCells(current);
    // Simple wall kicks: try in place, then one/two cells left or right.
    for (const kick of [0, -1, 1, -2, 2]) {
      if (!collides(current, kick, 0, cells)) {
        current.cells = cells;
        current.x += kick;
        return;
      }
    }
  }

  function ghostOffset() {
    let dy = 0;
    while (!collides(current, 0, dy + 1)) dy++;
    return dy;
  }

  // --- Game flow -----------------------------------------------------------

  function reset() {
    grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    bag = [];
    score = 0;
    lines = 0;
    level = 1;
    dropInterval = 1000;
    dropTimer = 0;
    current = nextFromBag();
    next = nextFromBag();
    updateHud();
  }

  function spawn() {
    current = next;
    next = nextFromBag();
    if (collides(current, 0, 0)) {
      gameOver();
      return false;
    }
    return true;
  }

  function lockPiece() {
    for (const [cx, cy] of current.cells) {
      const y = current.y + cy;
      if (y >= 0) grid[y][current.x + cx] = current.color;
    }
    clearLines();
    if (spawn()) draw();
  }

  function clearLines() {
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (grid[y].every((cell) => cell)) {
        grid.splice(y, 1);
        grid.unshift(new Array(COLS).fill(null));
        cleared++;
        y++; // re-check the row that just slid down into this index
      }
    }
    if (!cleared) return;
    lines += cleared;
    score += LINE_SCORES[cleared] * level;
    // Level up every 8 lines, ~22% faster per level - the wide 12-column board
    // gives more room, so the ramp is deliberately steep to compensate.
    const newLevel = Math.floor(lines / 8) + 1;
    if (newLevel !== level) {
      level = newLevel;
      dropInterval = Math.max(70, 1000 * Math.pow(0.78, level - 1));
    }
    updateHud();
  }

  function softDrop() {
    if (collides(current, 0, 1)) {
      lockPiece();
    } else {
      current.y++;
      score += 1;
      updateHud();
    }
  }

  function hardDrop() {
    const dy = ghostOffset();
    current.y += dy;
    score += dy * 2;
    updateHud();
    lockPiece();
  }

  function gameOver() {
    state = "over";
    stopLoop();
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    submitScore(score);
    showOverlay("over");
  }

  // --- Leaderboard ---------------------------------------------------------

  const leaderboard = document.getElementById("fb-leaderboard");
  const lbList = document.getElementById("fb-lb-list");
  const lbMeWrap = document.getElementById("fb-lb-me");
  const lbMeRow = document.getElementById("fb-lb-me-row");

  // Builds one row matching the server-rendered markup in gameFallingBlocks.ejs -
  // keep the classes in sync with the EJS side.
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

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
    linesEl.textContent = lines;
    levelEl.textContent = level;
  }

  // --- Rendering -----------------------------------------------------------

  const hasRoundRect = typeof ctx.roundRect === "function";

  function drawCell(context, x, y, cell, color, alpha) {
    context.globalAlpha = alpha || 1;
    context.fillStyle = color;
    const px = x * cell + 1;
    const py = y * cell + 1;
    context.beginPath();
    if (hasRoundRect) context.roundRect(px, py, cell - 2, cell - 2, 4);
    else context.rect(px, py, cell - 2, cell - 2);
    context.fill();
    // A lighter top edge gives the block a little depth without any sprite art.
    context.globalAlpha = (alpha || 1) * 0.25;
    context.fillStyle = "#ffffff";
    context.beginPath();
    if (hasRoundRect) context.roundRect(px, py, cell - 2, 6, 4);
    else context.rect(px, py, cell - 2, 6);
    context.fill();
    context.globalAlpha = 1;
  }

  function draw() {
    ctx.clearRect(0, 0, COLS * CELL, ROWS * CELL);

    // Faint grid lines.
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let x = 1; x < COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, ROWS * CELL);
      ctx.stroke();
    }
    for (let y = 1; y < ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(COLS * CELL, y * CELL + 0.5);
      ctx.stroke();
    }

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (grid[y][x]) drawCell(ctx, x, y, CELL, grid[y][x]);
      }
    }

    if (state === "running" || state === "paused") {
      const dy = ghostOffset();
      if (dy > 0) {
        for (const [cx, cy] of current.cells) {
          if (current.y + cy + dy >= 0) {
            drawCell(ctx, current.x + cx, current.y + cy + dy, CELL, current.color, 0.18);
          }
        }
      }
      for (const [cx, cy] of current.cells) {
        if (current.y + cy >= 0) {
          drawCell(ctx, current.x + cx, current.y + cy, CELL, current.color);
        }
      }
    }

    drawNext();
  }

  function drawNext() {
    const box = 120 / NEXT_CELL; // 5 cells
    nextCtx.clearRect(0, 0, 120, 120);
    if (!next) return;
    const xs = next.cells.map((c) => c[0]);
    const ys = next.cells.map((c) => c[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const offX = (box - w) / 2 - Math.min(...xs);
    const offY = (box - h) / 2 - Math.min(...ys);
    for (const [cx, cy] of next.cells) {
      drawCell(nextCtx, cx + offX, cy + offY, NEXT_CELL, next.color);
    }
  }

  // --- Loop ----------------------------------------------------------------

  function loop(time) {
    rafId = requestAnimationFrame(loop);
    const delta = time - lastTime;
    lastTime = time;
    dropTimer += delta;
    if (dropTimer >= dropInterval) {
      dropTimer = 0;
      if (collides(current, 0, 1)) {
        lockPiece();
      } else {
        current.y++;
      }
    }
    if (state === "running") draw();
  }

  function startLoop() {
    lastTime = performance.now();
    dropTimer = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- Overlay / state transitions ----------------------------------------

  function showOverlay(kind) {
    const d = overlay.dataset;
    overlayScore.hidden = kind !== "over";
    if (kind === "start") {
      overlayTitle.textContent = d.titleStart;
      overlayButton.textContent = d.buttonStart;
    } else if (kind === "paused") {
      overlayTitle.textContent = d.titlePaused;
      overlayButton.textContent = d.buttonResume;
    } else {
      overlayTitle.textContent = d.titleOver;
      overlayScore.textContent = d.finalScoreLabel + ": " + score;
      overlayButton.textContent = d.buttonAgain;
    }
    // Inline style rather than the hidden attribute: the overlay carries
    // Tailwind's .grid utility, which would win over [hidden]'s display:none.
    overlay.style.display = "";
  }

  function hideOverlay() {
    overlay.style.display = "none";
  }

  function start() {
    reset();
    state = "running";
    hideOverlay();
    draw();
    startLoop();
  }

  function pause() {
    if (state !== "running") return;
    state = "paused";
    stopLoop();
    showOverlay("paused");
  }

  function resume() {
    if (state !== "paused") return;
    state = "running";
    hideOverlay();
    startLoop();
  }

  overlayButton.addEventListener("click", () => {
    if (state === "paused") resume();
    else start();
    overlayButton.blur();
  });

  // Auto-pause when the tab loses focus - an unwatched game shouldn't end itself.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("blur", pause);

  // --- Input ---------------------------------------------------------------

  const KEYS = {
    ArrowLeft: () => move(-1),
    ArrowRight: () => move(1),
    ArrowDown: softDrop,
    ArrowUp: tryRotate,
    " ": hardDrop,
    KeyA: () => move(-1),
    KeyD: () => move(1),
    KeyS: softDrop,
    KeyW: tryRotate,
    KeyR: tryRotate,
  };

  function move(dx) {
    if (!collides(current, dx, 0)) current.x += dx;
  }

  document.addEventListener("keydown", (event) => {
    if (event.code === "KeyP" && (state === "running" || state === "paused")) {
      event.preventDefault();
      if (state === "running") pause();
      else resume();
      return;
    }
    if (state !== "running") return;
    const action = KEYS[event.key] || KEYS[event.code];
    if (!action) return;
    event.preventDefault(); // keep arrows/space from scrolling the page mid-game
    action();
    draw();
  });

  function bindTouch(id, action) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      if (state !== "running") return;
      action();
      draw();
    });
  }
  bindTouch("fb-touch-left", () => move(-1));
  bindTouch("fb-touch-right", () => move(1));
  bindTouch("fb-touch-rotate", tryRotate);
  bindTouch("fb-touch-down", softDrop);
  bindTouch("fb-touch-drop", hardDrop);

  // --- Boot ----------------------------------------------------------------

  best = readBest();
  reset();
  draw();
  showOverlay("start");
})();
