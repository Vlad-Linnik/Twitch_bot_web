// /games/match-3 - a timed crystal-matching marathon. 3 minutes on the clock,
// score as many points as possible: swap two adjacent crystals to create a
// match of 3+, and any gravity-triggered cascade off that single swap scores
// progressively more per step (see engines/match3Engine.js's
// computeCascadeScore for the exact multiplier design). Board logic lives in
// that engine module (loaded via <script> tag before this file - see
// gameMatch3.ejs) so it's shared with the node:test suite, same split as
// minesweeper.js/minesweeperEngine.js right next to these files.
//
// Shape bonuses: no charging or manual activation - engine.resolveCascade
// itself detects a match's shape (a 4-in-a-row, a T-crossing, an L/Г corner)
// and widens that step's clear to the whole column/row/type/3x3-area
// automatically (see match3Engine.js's classifyGroupShape). This file's only
// job for that is to show which shape fired via `step.specials` - see
// showCombo.
(function () {
  "use strict";

  const engine = window.Match3Engine;
  const root = document.getElementById("m3-board");
  if (!root || !engine) return;

  const ROWS = 8;
  const COLS = 8;
  const TYPE_COUNT = 6;
  const RUN_MS = 3 * 60 * 1000;

  // Tinted "socket" backdrop per crystal type (kept subtle - the artwork
  // itself is what tells types apart) plus its sprite, sliced from a
  // hand-generated sheet into public/img/games/match3/.
  const CRYSTAL_SOCKETS = [
    "bg-rose-500/15",
    "bg-sky-400/15",
    "bg-emerald-400/15",
    "bg-violet-500/15",
    "bg-orange-400/15",
    "bg-neutral-200/10",
  ];
  const CRYSTAL_IMAGES = ["red.png", "blue.png", "green.png", "purple.png", "orange.png", "diamond.png"];
  const CRYSTAL_IMG_BASE = "/img/games/match3/";

  // Same clone-and-play pattern as minesweeper.js/pipe-dodger.js's
  // playSound(), so overlapping triggers don't cut each other off.
  const SOUND_BASE = "/sounds/games/match3/";
  const SOUNDS = {
    select: new Audio(SOUND_BASE + "select.wav"),
    invalid: new Audio(SOUND_BASE + "invalid.wav"),
    shatter: new Audio(SOUND_BASE + "shatter.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

  function playSound(name, options) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      const volumeMult = (options && options.volumeMult) || 1;
      node.volume = Math.min(1, base.volume * (window.gameVolume ? window.gameVolume.get() : 1) * volumeMult);
      if (options && options.rate) node.playbackRate = options.rate;
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

  // Cells cleared by a match get a brief shatter pop before the settled
  // board (post-gravity/refill) renders - see resolveAndScore below.
  const SHATTER_MS = 260;
  const SWAP_MS = 150;
  const FALL_MS = 260;

  // A step clearing this many cells or more (a merged cascade, or a shape
  // bonus's column/row/area/type blast - see match3Engine.js's
  // classifyGroupShape) gets the bigger treatment: a board shake + flash,
  // denser/further-flying shards, and a deeper layered boom on top of the
  // normal shatter sound - see animateCascadeSteps below.
  const BIG_CLEAR_THRESHOLD = 8;
  const BOARD_BLAST_MS = 420;

  // Real pixel stride between adjacent cells (accounts for the board's grid
  // gap, not just cell width) - measured fresh each time rather than cached
  // since it depends on the current layout/viewport.
  function measureStride() {
    const a = cellEls[0][0].getBoundingClientRect();
    const bx = cellEls[0][1].getBoundingClientRect();
    const by = cellEls[1][0].getBoundingClientRect();
    return { x: bx.left - a.left, y: by.top - a.top };
  }

  // Colored shard particles that burst out of a matched cell alongside its
  // shatter pop - deliberately a mixed palette per burst (not just the
  // matched crystal's own color) for a more "explosion of confetti" look.
  const shardsRoot = document.getElementById("m3-shards");
  const SHARD_COLORS = ["#fb7185", "#38bdf8", "#34d399", "#c084fc", "#fb923c", "#f5f5f5"];
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function spawnShards(r, c, big) {
    if (!shardsRoot || reduceMotion) return;
    const rootRect = shardsRoot.getBoundingClientRect();
    const cellRect = cellEls[r][c].getBoundingClientRect();
    const x = cellRect.left + cellRect.width / 2 - rootRect.left;
    const y = cellRect.top + cellRect.height / 2 - rootRect.top;
    const count = (big ? 9 : 6) + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const shard = document.createElement("span");
      shard.className = "m3-shard";
      const angle = Math.random() * Math.PI * 2;
      const dist = (big ? 60 : 36) + Math.random() * (big ? 130 : 90);
      const size = (big ? 6 : 5) + Math.random() * 6;
      shard.style.left = x + "px";
      shard.style.top = y + "px";
      shard.style.width = size + "px";
      shard.style.height = size + "px";
      shard.style.background = SHARD_COLORS[Math.floor(Math.random() * SHARD_COLORS.length)];
      shard.style.setProperty("--tx", Math.cos(angle) * dist + "px");
      shard.style.setProperty("--ty", Math.sin(angle) * dist + "px");
      shard.style.setProperty("--rot", Math.floor(Math.random() * 360 - 180) + "deg");
      shard.style.setProperty("--m3-shard-ms", Math.floor(450 + Math.random() * 200) + "ms");
      shard.addEventListener("animationend", () => shard.remove(), { once: true });
      shardsRoot.appendChild(shard);
    }
  }

  // A big blast (see BIG_CLEAR_THRESHOLD) also launches the actual crystal
  // sprite itself - not just confetti shards - tumbling off past the edge
  // of the board, for a "the whole thing is exploding outward" read. Reads
  // the cell's own current background-image rather than tracking each
  // step's per-cell type separately: at the moment this fires, the cascade
  // has already been resolved in the engine, but this cell's DOM element
  // hasn't been repainted for the step yet, so its background-image is
  // still the pre-clear crystal - exactly the sprite that should fly off.
  function spawnFlyingCrystal(r, c) {
    if (!shardsRoot || reduceMotion) return;
    const bgImage = cellEls[r][c].style.backgroundImage;
    if (!bgImage) return;
    const rootRect = shardsRoot.getBoundingClientRect();
    const cellRect = cellEls[r][c].getBoundingClientRect();
    const x = cellRect.left + cellRect.width / 2 - rootRect.left;
    const y = cellRect.top + cellRect.height / 2 - rootRect.top;
    const angle = Math.random() * Math.PI * 2;
    // Far enough that a crystal launched from any cell clears the board's
    // own box, regardless of which corner/edge it starts from.
    const dist = Math.max(rootRect.width, rootRect.height) * (0.75 + Math.random() * 0.45);
    const size = cellRect.width * (0.8 + Math.random() * 0.35);
    const crystal = document.createElement("span");
    crystal.className = "m3-flying-crystal bg-contain bg-center bg-no-repeat";
    crystal.style.left = x + "px";
    crystal.style.top = y + "px";
    crystal.style.width = size + "px";
    crystal.style.height = size + "px";
    crystal.style.backgroundImage = bgImage;
    crystal.style.setProperty("--tx", Math.cos(angle) * dist + "px");
    crystal.style.setProperty("--ty", Math.sin(angle) * dist + "px");
    crystal.style.setProperty("--rot", Math.floor(Math.random() * 720 - 360) + "deg");
    crystal.style.setProperty("--m3-fly-ms", Math.floor(650 + Math.random() * 300) + "ms");
    crystal.addEventListener("animationend", () => crystal.remove(), { once: true });
    shardsRoot.appendChild(crystal);
  }

  const scoreEl = document.getElementById("m3-score");
  const timeEl = document.getElementById("m3-time");
  const comboEl = document.getElementById("m3-combo");

  const overlay = document.getElementById("m3-overlay");
  const overlayTitle = document.getElementById("m3-overlay-title");
  const overlayScore = document.getElementById("m3-overlay-score");
  const overlayButton = document.getElementById("m3-overlay-button");

  let grid;
  let cellEls;
  let score = 0;
  let deadline = 0;
  let tickHandle = null;
  let state = "idle"; // idle | running | over
  let busy = false;
  let selected = null; // {r,c} of the first tap in a two-tap swap

  function fmtTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function freshGrid() {
    let g = engine.generateGrid(ROWS, COLS, TYPE_COUNT, Math.random);
    while (!engine.hasAnyLegalMove(g)) g = engine.generateGrid(ROWS, COLS, TYPE_COUNT, Math.random);
    return g;
  }

  function buildBoardDom() {
    root.textContent = "";
    root.style.gridTemplateColumns = "repeat(" + COLS + ", minmax(0, 1fr))";
    cellEls = Array.from({ length: ROWS }, () => new Array(COLS));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "m3-cell";
        el.addEventListener("click", () => handleTap(r, c));
        cellEls[r][c] = el;
        root.appendChild(el);
      }
    }
  }

  // Sets a cell's crystal visuals for `type`, independent of `grid` - shared
  // by renderCell (the normal live-grid path) and animateCascadeSteps (which
  // paints from a step's `gridAfter` snapshot instead, since by the time it
  // animates, `grid` already holds the cascade's final state).
  function paintCell(r, c, type, isSelected) {
    const el = cellEls[r][c];
    el.className =
      "m3-cell bg-contain bg-center bg-no-repeat " +
      CRYSTAL_SOCKETS[type] +
      (isSelected ? " m3-cell-selected" : "");
    el.style.backgroundImage = "url(" + CRYSTAL_IMG_BASE + CRYSTAL_IMAGES[type] + ")";
  }

  function renderCell(r, c) {
    const isSelected = selected && selected.r === r && selected.c === c;
    paintCell(r, c, grid[r][c], isSelected);
  }

  function renderAll() {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) renderCell(r, c);
  }

  // Slides the two cells' sprites into each other's position, then hands off
  // to onDone (which performs the actual grid swap + re-render) once the
  // slide completes - the re-render lands exactly where the slide ended, so
  // the handoff is seamless.
  function animateSwap(a, b, onDone) {
    const stride = measureStride();
    const dx = (b.c - a.c) * stride.x;
    const dy = (b.r - a.r) * stride.y;
    const elA = cellEls[a.r][a.c];
    const elB = cellEls[b.r][b.c];
    for (const el of [elA, elB]) {
      el.style.transition = "none";
      el.style.zIndex = "2";
    }
    void elA.offsetWidth;
    elA.style.transition = "transform " + SWAP_MS + "ms ease";
    elB.style.transition = "transform " + SWAP_MS + "ms ease";
    elA.style.transform = "translate(" + dx + "px, " + dy + "px)";
    elB.style.transform = "translate(" + -dx + "px, " + -dy + "px)";
    setTimeout(() => {
      for (const el of [elA, elB]) {
        el.style.transition = "";
        el.style.transform = "";
        el.style.zIndex = "";
      }
      onDone();
    }, SWAP_MS);
  }

  // Animates one resolveCascade() step (the shatter pop on its matched
  // cells, then its survivors/new crystals dropping into place from
  // `step.gridAfter`) and recurses to the next step, so a multi-step cascade
  // plays as a real falling chain instead of jump-cutting to the final grid.
  function animateCascadeSteps(steps, i, onAllDone) {
    if (i >= steps.length) {
      onAllDone();
      return;
    }
    const step = steps[i];
    const stride = measureStride();
    const isBigBlast = step.clearedCells.length >= BIG_CLEAR_THRESHOLD;

    playSound("shatter");
    if (isBigBlast) {
      playSound("shatter", { rate: 0.6, volumeMult: 1.15 }); // layered deeper boom
      root.classList.remove("m3-board-blast");
      void root.offsetWidth;
      root.classList.add("m3-board-blast");
      setTimeout(() => root.classList.remove("m3-board-blast"), BOARD_BLAST_MS);
    }
    for (const [r, c] of step.clearedCells) {
      const el = cellEls[r][c];
      if (isBigBlast) spawnFlyingCrystal(r, c);
      el.classList.remove("m3-cell-shatter");
      void el.offsetWidth;
      el.classList.add("m3-cell-shatter");
      spawnShards(r, c, isBigBlast);
    }

    setTimeout(() => {
      for (const mv of step.moves) {
        const el = cellEls[mv.toRow][mv.c];
        const type = step.gridAfter[mv.toRow][mv.c];
        el.style.transition = "none";
        paintCell(mv.toRow, mv.c, type, false);
        el.style.transform = "translateY(" + -(mv.toRow - mv.fromRow) * stride.y + "px)";
        void el.offsetWidth;
        el.style.transition = "transform " + FALL_MS + "ms cubic-bezier(0.34, 1.2, 0.64, 1)";
        el.style.transform = "";
      }

      // New crystals in the same column fall in stacked - the topmost of a
      // column's new cells is treated as having fallen from furthest above.
      const byCol = new Map();
      for (const cell of step.newCells) {
        if (!byCol.has(cell.c)) byCol.set(cell.c, []);
        byCol.get(cell.c).push(cell.r);
      }
      for (const [c, rows] of byCol) {
        rows.sort((x, y) => x - y);
        const k = rows.length;
        rows.forEach((r, idx) => {
          const el = cellEls[r][c];
          const type = step.gridAfter[r][c];
          el.style.transition = "none";
          paintCell(r, c, type, false);
          el.style.transform = "translateY(" + -(k - idx) * stride.y + "px)";
          void el.offsetWidth;
          el.style.transition = "transform " + FALL_MS + "ms cubic-bezier(0.34, 1.2, 0.64, 1)";
          el.style.transform = "";
        });
      }

      setTimeout(() => animateCascadeSteps(steps, i + 1, onAllDone), FALL_MS);
    }, SHATTER_MS);
  }

  // `specials` is every step's shape.kind across the whole cascade (see
  // match3Engine.js's classifyGroupShape) - the first one, if any, swaps the
  // usual "Combo" label for that shape's name (comboEl's data-clear-column/
  // -row/-area/-type attributes, camelCase-matching the engine's own kind
  // strings so no separate lookup table is needed here).
  function showCombo(stepIndex, points, specials) {
    if (!comboEl) return;
    const kind = specials && specials[0];
    const label = (kind && comboEl.dataset[kind]) || comboEl.dataset.label;
    comboEl.textContent = label + " x" + stepIndex + " (+" + points + ")";
    comboEl.classList.remove("m3-combo-pop", "m3-combo-special");
    void comboEl.offsetWidth;
    comboEl.classList.add("m3-combo-pop");
    if (kind) comboEl.classList.add("m3-combo-special");
  }

  function handleTap(r, c) {
    if (state !== "running" || busy) return;
    if (!selected) {
      selected = { r, c };
      renderCell(r, c);
      playSound("select");
      return;
    }
    const a = selected;
    const b = { r, c };
    selected = null;
    renderCell(a.r, a.c);
    if (a.r === b.r && a.c === b.c) return;

    if (!engine.isAdjacent(a, b)) {
      selected = { r, c };
      renderCell(r, c);
      playSound("select");
      return;
    }

    if (!engine.isValidSwap(grid, a, b)) {
      // Invalid swap: briefly show it rejected via a shake, then snap back -
      // no state change since isValidSwap already reverted its scratch swap.
      flashInvalid(a, b);
      return;
    }

    busy = true;
    animateSwap(a, b, () => {
      engine.swapCells(grid, a, b);
      renderCell(a.r, a.c);
      renderCell(b.r, b.c);
      resolveAndScore();
    });
  }

  function flashInvalid(a, b) {
    playSound("invalid");
    for (const cell of [a, b]) {
      const el = cellEls[cell.r][cell.c];
      el.classList.remove("m3-cell-invalid");
      void el.offsetWidth;
      el.classList.add("m3-cell-invalid");
    }
  }

  function resolveAndScore() {
    const { steps } = engine.resolveCascade(grid, TYPE_COUNT, Math.random);
    animateCascadeSteps(steps, 0, () => {
      const gained = engine.computeCascadeScore(steps);
      if (gained > 0) {
        score += gained;
        scoreEl.textContent = score;
        const specials = [];
        for (const step of steps) specials.push(...step.specials);
        showCombo(steps.length, gained, specials);
      }
      if (!engine.hasAnyLegalMove(grid)) {
        grid = freshGrid();
        renderAll();
      }
      busy = false;
    });
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
    score = 0;
    scoreEl.textContent = "0";
    selected = null;
    busy = false;
    grid = freshGrid();
    buildBoardDom();
    renderAll();
    deadline = Date.now() + RUN_MS;
    state = "running";
    hideOverlay();
    tick();
    tickHandle = setInterval(tick, 250);
  }

  function endRun() {
    state = "over";
    clearInterval(tickHandle);
    tickHandle = null;
    submitScore(score);
    showOverlay("over");
  }

  // --- Leaderboard -----------------------------------------------------------
  // Same wiring as 2048.js/minesweeper.js - see those files' comments.

  const leaderboard = document.getElementById("m3-leaderboard");
  const lbList = document.getElementById("m3-lb-list");
  const lbMeWrap = document.getElementById("m3-lb-me");
  const lbMeRow = document.getElementById("m3-lb-me-row");

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

  const leaveDialog = document.getElementById("m3-leave-confirm-dialog");
  const leaveSaveBtn = document.getElementById("m3-leave-save");
  const leaveDiscardBtn = document.getElementById("m3-leave-discard");
  const leaveCancelBtn = document.getElementById("m3-leave-cancel");
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

  // --- Overlay -----------------------------------------------------------------

  function showOverlay(kind) {
    const d = overlay.dataset;
    overlayScore.hidden = kind !== "over";
    if (kind === "start") {
      overlayTitle.textContent = d.titleStart;
      overlayButton.textContent = d.buttonStart;
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

  overlayButton.addEventListener("click", () => {
    startRun();
    overlayButton.blur();
  });

  showOverlay("start");
})();
