// /games/falling-blocks - a fully client-side falling-blocks puzzle. No server
// state: the only thing persisted is the best score, in localStorage. All
// user-visible text is server-rendered in gameFallingBlocks.ejs (the overlay
// reads its labels from data-* attributes there) so i18n stays in one place.
(function () {
  "use strict";

  const board = document.getElementById("fb-board");
  const engine = window.FallingBlocksEngine;
  if (!board || !engine) return;

  const COLS = engine.COLS;
  const ROWS = engine.ROWS;
  const CELL = 30;
  const NEXT_CELL = 24;
  const BEST_KEY = "fallingBlocksBest";

  // Seven one-sided tetrominoes - the shapes themselves are game mechanics
  // (public domain); names, colors and rendering here are our own. Colors are
  // the Tailwind 400-series hues the rest of the site already uses.
  // Piece shapes, scoring, the 7-bag and every rule that decides the score all
  // live in the engine now, so the server can re-simulate a run through the
  // exact same code (lib/gameReplay/falling-blocks.js).
  const PIECES = engine.PIECES;

  // Anti-cheat: inputs are recorded and the run is replayed server-side. Bump
  // RULES_VERSION here AND in lib/gameReplay/falling-blocks.js together
  // whenever a gameplay constant changes - a mismatch makes the server skip
  // verification rather than mis-score an honest run.
  const RULES_VERSION = 1;

  const run = window.SoloRun.create({
    gameKey: "falling-blocks",
    rulesVersion: RULES_VERSION,
    rootId: "fb-leaderboard",
    listId: "fb-lb-list",
    meWrapId: "fb-lb-me",
    meRowId: "fb-lb-me-row",
    // A marathon log outgrows the browser's 64kB keepalive beacon cap, so it
    // is banked mid-run rather than sent whole at the end.
    checkpoint: true,
    // Inputs are timestamped in SIMULATION time, not wall time - see simTime
    // below - so the recorded clock matches what the server replays.
    now: () => simTime,
  });

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

  // The authoritative simulation. grid/current/next/score below are read
  // straight off it by the renderer; nothing outside the engine may change them.
  let gs = null;
  // Simulation clock, in ms, advanced only in whole engine steps and only
  // while the game is actually running. That last part is why no pause opcode
  // is needed: a pause (including the automatic one on tab blur) simply stops
  // this clock, so it never happened as far as the replay is concerned.
  let simTime = 0;
  let stepAcc = 0;
  let score, lines, level, best;
  let state = "idle"; // idle | running | paused | over
  // Guards start() against re-entry: stopLoop() at the top only cancels an
  // ALREADY-started loop, so it can't stop two clicks that both land while
  // the first is still awaiting run.begin() - both would otherwise proceed
  // to their own reset()/startLoop() and race each other.
  let starting = false;
  let rafId = null;
  let lastTime = 0;
  let particles = [];

  // --- Sound -----------------------------------------------------------------

  const SOUND_BASE = "/sounds/games/falling-blocks/";
  const SOUNDS = {
    rotate: new Audio(SOUND_BASE + "rotate.wav"),
    land: new Audio(SOUND_BASE + "land.wav"),
    combo: new Audio(SOUND_BASE + "combo.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

  // Cloning the node lets overlapping plays (rapid rotates, chained clears)
  // stack instead of the next play cutting the previous one off.
  function playSound(name, opts) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      const master = window.gameVolume ? window.gameVolume.get() : 1;
      node.volume = (opts && opts.volume != null ? opts.volume : base.volume) * master;
      node.playbackRate = (opts && opts.rate) || 1;
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

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

  // --- Game flow -----------------------------------------------------------

  function reset() {
    // run.rng is the server's seeded stream while the run is ranked, plain
    // Math.random otherwise. The 7-bag shuffle is the only gameplay
    // randomness, and it must come from here - a bare Math.random() would
    // desync the server's replay immediately.
    gs = engine.createState(run.rng);
    simTime = 0;
    stepAcc = 0;
    score = 0;
    lines = 0;
    level = 1;
    particles = [];
    hideCombo();
    updateHud();
  }

  // Everything the engine did that the player should SEE or HEAR. The engine
  // itself is silent and has no idea a DOM exists.
  function presentResult(result) {
    if (!result) return;
    if (result.rotated) playSound("rotate");
    if (result.locked) playSound("land");
    for (const row of result.rows || []) spawnRowExplosion(row.y, row.cells);
    if (result.cleared >= 2) {
      showCombo(result.cleared);
      // Pitch climbs with the size of the clear so a tetris feels more
      // rewarding to hear.
      playSound("combo", { rate: Math.min(1.6, 1 + (result.cleared - 1) * 0.15) });
    }
    score = gs.score;
    lines = gs.lines;
    level = gs.level;
    updateHud();
    if (result.over) gameOver();
    else if (result.locked) draw();
  }

  // Applies an input AND records it. `synthetic` marks a derived event - an OS
  // key auto-repeat, or one step of a drag gesture that produced several moves
  // from a single pointer event. Those are replayed identically but excluded
  // from the bot-detection timing analysis: held keys repeat metronomically
  // (~33ms) and drag bursts land at dt=0, so counting them would flag every
  // player who holds an arrow key. See lib/gameReplay/inputHeuristics.js.
  function applyOp(op, synthetic) {
    if (state !== "running" || gs.over) return;
    run.record(op, undefined, undefined, undefined, synthetic);
    presentResult(engine.applyInput(gs, op));
  }

  function tryRotate() {
    applyOp(engine.OP_ROTATE);
  }

  // --- Explosion particles ---------------------------------------------------

  // `cells` is the row's colours as they were BEFORE the engine spliced the
  // row out - the grid no longer holds them by the time this runs.
  function spawnRowExplosion(y, cells) {
    for (let x = 0; x < COLS; x++) {
      const color = cells[x];
      if (!color) continue;
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL / 2;
      for (let i = 0; i < 6; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.2 + Math.random() * 2.8;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5,
          color,
          size: 2 + Math.random() * 2.5,
          life: 0,
          maxLife: 400 + Math.random() * 250,
        });
      }
    }
  }

  function updateParticles(delta) {
    if (!particles.length) return;
    const kept = [];
    const dt = delta / 16.67;
    for (const p of particles) {
      p.life += delta;
      if (p.life >= p.maxLife) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.15 * dt; // gravity
      kept.push(p);
    }
    particles = kept;
  }

  function drawParticles() {
    for (const p of particles) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.size * (1 - t * 0.4)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- Combo callout -----------------------------------------------------------

  const comboEl = document.getElementById("fb-combo");

  function showCombo(multiplier) {
    if (!comboEl) return;
    comboEl.textContent = comboEl.dataset.label + " ×" + multiplier;
    // Toggling the class off then on retriggers the CSS animation even when
    // the same multiplier pops twice in a row.
    comboEl.classList.remove("fb-combo-pop");
    void comboEl.offsetWidth;
    comboEl.classList.add("fb-combo-pop");
  }

  function hideCombo() {
    if (!comboEl) return;
    comboEl.classList.remove("fb-combo-pop");
    comboEl.textContent = "";
  }

  function softDrop(synthetic) {
    applyOp(engine.OP_SOFT_DROP, synthetic);
  }

  function hardDrop() {
    applyOp(engine.OP_HARD_DROP);
  }

  function gameOver() {
    state = "over";
    stopLoop();
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    run.finish(score);
    showOverlay("over");
  }

  // --- Leaderboard / leave-page confirmation ---------------------------------
  // Both used to be copy-pasted into each of the six solo games; they now live
  // in soloRunClient.js, which also owns the run token and input recording.

  function gameInProgress() {
    return state === "running" || state === "paused";
  }

  window.SoloRun.wireLeaveConfirm({
    dialogId: "fb-leave-confirm-dialog",
    saveId: "fb-leave-save",
    discardId: "fb-leave-discard",
    cancelId: "fb-leave-cancel",
    isInProgress: gameInProgress,
    canSave: () => run.canSubmit(),
    onOpen: pause,
    onSave: () => run.leaveBeacon(score),
  });

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
        if (gs.grid[y][x]) drawCell(ctx, x, y, CELL, gs.grid[y][x]);
      }
    }

    if (state === "running" || state === "paused") {
      const dy = engine.ghostOffset(gs);
      if (dy > 0) {
        for (const [cx, cy] of gs.current.cells) {
          if (gs.current.y + cy + dy >= 0) {
            drawCell(ctx, gs.current.x + cx, gs.current.y + cy + dy, CELL, gs.current.color, 0.18);
          }
        }
      }
      for (const [cx, cy] of gs.current.cells) {
        if (gs.current.y + cy >= 0) {
          drawCell(ctx, gs.current.x + cx, gs.current.y + cy, CELL, gs.current.color);
        }
      }
    }

    drawParticles();
    drawNext();
  }

  function drawNext() {
    const box = 120 / NEXT_CELL; // 5 cells
    nextCtx.clearRect(0, 0, 120, 120);
    if (!gs.next) return;
    const xs = gs.next.cells.map((c) => c[0]);
    const ys = gs.next.cells.map((c) => c[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const offX = (box - w) / 2 - Math.min(...xs);
    const offY = (box - h) / 2 - Math.min(...ys);
    for (const [cx, cy] of gs.next.cells) {
      drawCell(nextCtx, cx + offX, cy + offY, NEXT_CELL, gs.next.color);
    }
  }

  // --- Loop ----------------------------------------------------------------

  function loop(time) {
    rafId = requestAnimationFrame(loop);
    const delta = time - lastTime;
    lastTime = time;
    updateParticles(delta);

    // Gravity advances in whole fixed steps only, and only while running. The
    // server advances the identical loop, so the two stay in step; and because
    // simTime stops when the game does, a pause is invisible to the replay.
    if (state === "running" && !gs.over) {
      stepAcc += delta;
      while (stepAcc >= engine.FIXED_DT_MS && !gs.over) {
        const result = engine.step(gs);
        stepAcc -= engine.FIXED_DT_MS;
        simTime += engine.FIXED_DT_MS;
        if (result.locked || result.cleared) presentResult(result);
      }
    }
    if (state === "running") draw();
  }

  function startLoop() {
    lastTime = performance.now();
    stepAcc = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- Overlay / state transitions ----------------------------------------

  const overlayHint = document.getElementById("fb-overlay-hint");

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
    // Shown on every overlay screen (start/paused/over), not just the very
    // first launch - a one-time hint is too easy to miss, and mobile players
    // land back on this overlay constantly (every pause, every game over).
    // The element is sm:hidden anyway, so desktop never sees it.
    if (overlayHint) {
      overlayHint.textContent = d.touchHint;
      overlayHint.hidden = false;
    }
    // Inline style rather than the hidden attribute: the overlay carries
    // Tailwind's .grid utility, which would win over [hidden]'s display:none.
    overlay.style.display = "";
  }

  function hideOverlay() {
    overlay.style.display = "none";
  }

  async function start() {
    if (starting) return;
    starting = true;
    try {
      stopLoop(); // safe to call while already running (the restart button) - avoids a second rAF loop
      // Register the run before reset() deals the first pieces - it needs the
      // server's seed. begin() races itself against a short timeout and
      // resolves either way, so a slow or unreachable server costs a moment,
      // never the ability to play; the run is simply unranked then.
      run.abandon();
      await run.begin();
      reset();
      state = "running";
      hideOverlay();
      draw();
      startLoop();
    } finally {
      starting = false;
    }
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

  const restartBtn = document.getElementById("fb-restart");
  restartBtn?.addEventListener("click", () => {
    start();
    restartBtn.blur();
  });

  // Auto-pause when the tab loses focus - an unwatched game shouldn't end itself.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("blur", pause);

  // --- Input ---------------------------------------------------------------

  const KEYS = {
    ArrowLeft: engine.OP_LEFT,
    ArrowRight: engine.OP_RIGHT,
    ArrowDown: engine.OP_SOFT_DROP,
    ArrowUp: engine.OP_ROTATE,
    " ": engine.OP_HARD_DROP,
    KeyA: engine.OP_LEFT,
    KeyD: engine.OP_RIGHT,
    KeyS: engine.OP_SOFT_DROP,
    KeyW: engine.OP_ROTATE,
    KeyR: engine.OP_ROTATE,
  };

  function move(dx, synthetic) {
    applyOp(dx < 0 ? engine.OP_LEFT : engine.OP_RIGHT, synthetic);
  }

  document.addEventListener("keydown", (event) => {
    if (event.code === "KeyP" && (state === "running" || state === "paused")) {
      event.preventDefault();
      if (state === "running") pause();
      else resume();
      return;
    }
    if (state !== "running") return;
    const op = KEYS[event.key] !== undefined ? KEYS[event.key] : KEYS[event.code];
    if (op === undefined) return;
    event.preventDefault(); // keep arrows/space from scrolling the page mid-game
    // event.repeat is the OS auto-repeat of a held key. It is real input and
    // is replayed as such, but it must not feed the timing heuristics: at a
    // metronomic ~33ms it would make every player who holds a key look like a
    // script.
    applyOp(op, event.repeat);
    draw();
  });

  // Fires on pointerdown rather than click: a tap that drifts even a couple
  // of px - completely normal when mashing the rotate button mid-game - can
  // make the browser read it as a scroll attempt and silently drop the
  // synthesized click, which is exactly the "doesn't work on the first tap"
  // symptom. pointerdown fires the instant contact happens, before any drift
  // is possible. The click listener stays as a fallback for keyboard/
  // assistive-tech activation (which never fires a pointerdown first); the
  // lastPointerFire guard stops a browser that still synthesizes a click
  // after a touch pointerdown from applying the action twice.
  function bindTap(el, handler) {
    if (!el) return;
    let lastPointerFire = 0;
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      lastPointerFire = performance.now();
      handler();
    });
    el.addEventListener("click", () => {
      if (performance.now() - lastPointerFire < 500) return;
      handler();
    });
  }

  function bindTouch(id, action) {
    bindTap(document.getElementById(id), () => {
      if (state !== "running") return;
      action();
      draw();
    });
  }
  bindTouch("fb-touch-rotate", tryRotate);

  bindTap(document.getElementById("fb-touch-pause"), () => {
    if (state === "running") pause();
    else if (state === "paused") resume();
  });

  // --- Leaderboard collapse (mobile only - "hidden sm:block" on fb-lb-body
  // always wins at the sm breakpoint regardless of this toggle's state, same
  // pattern the desktop-only controls-legend card already relies on). ------

  const lbToggle = document.getElementById("fb-lb-toggle");
  const lbBody = document.getElementById("fb-lb-body");
  const lbChevron = document.getElementById("fb-lb-chevron");
  lbToggle?.addEventListener("click", () => {
    const collapsed = lbBody.classList.toggle("hidden");
    lbToggle.setAttribute("aria-expanded", String(!collapsed));
    if (lbChevron) lbChevron.style.transform = collapsed ? "" : "rotate(180deg)";
  });

  // --- Touch gestures on the board ------------------------------------------
  // Mobile has no keyboard, so the whole control scheme lives here instead of
  // the old button row: tap the falling piece to rotate, press-and-drag to
  // slide it left/right under your finger, swipe down to hard-drop, and tap
  // the bottom rows of the field for a single soft-drop step (mirrors the
  // down arrow on desktop). A rotate button still exists for anyone who finds
  // tapping the piece itself fiddly.

  const TAP_MAX_MOVE = 12; // px of finger travel still counted as a tap, not a drag
  const SWIPE_DOWN_MIN_DY = 40; // px of downward travel required to count as a swipe
  const BOTTOM_ZONE_ROWS = 4; // tapping within the bottom N rows soft-drops instead of rotating

  function boardPointFromEvent(event) {
    const rect = board.getBoundingClientRect();
    return {
      col: ((event.clientX - rect.left) / rect.width) * COLS,
      row: ((event.clientY - rect.top) / rect.height) * ROWS,
    };
  }

  function pieceCellsAt(col, row) {
    const cx = Math.floor(col);
    const cy = Math.floor(row);
    return gs.current.cells.some(([px, py]) => gs.current.x + px === cx && gs.current.y + py === cy);
  }

  let touch = null;

  board.addEventListener("pointerdown", (event) => {
    if (state !== "running") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const pt = boardPointFromEvent(event);
    touch = {
      id: event.pointerId,
      startCol: pt.col,
      startRow: pt.row,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      axis: null, // "x" once a horizontal drag is recognized, "y" once vertical
      lastAppliedShift: 0,
    };
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener("pointermove", (event) => {
    if (!touch || event.pointerId !== touch.id || state !== "running") return;
    const dxPx = event.clientX - touch.startX;
    const dyPx = event.clientY - touch.startY;
    if (!touch.moved) {
      if (Math.hypot(dxPx, dyPx) < TAP_MAX_MOVE) return;
      touch.moved = true;
      touch.axis = Math.abs(dxPx) >= Math.abs(dyPx) ? "x" : "y";
    }
    if (touch.axis !== "x") return; // vertical drags are resolved as a swipe on release
    const pt = boardPointFromEvent(event);
    const shift = Math.round(pt.col - touch.startCol);
    const delta = shift - touch.lastAppliedShift;
    if (delta === 0) return;
    const dir = delta > 0 ? 1 : -1;
    // One pointer event can cross several columns at once, so this is a burst
    // of moves at the same instant. All but the first are marked synthetic:
    // recorded and replayed, but kept out of the timing analysis, where a
    // cluster at dt=0 would read as superhuman input.
    for (let i = 0; i < Math.abs(delta); i++) move(dir, i > 0);
    touch.lastAppliedShift = shift;
    draw();
  });

  function endTouch(event) {
    if (!touch || event.pointerId !== touch.id) return;
    const dxPx = event.clientX - touch.startX;
    const dyPx = event.clientY - touch.startY;
    if (state === "running") {
      if (!touch.moved) {
        if (pieceCellsAt(touch.startCol, touch.startRow)) tryRotate();
        else if (touch.startRow >= ROWS - BOTTOM_ZONE_ROWS) softDrop();
      } else if (touch.axis === "y" && dyPx > SWIPE_DOWN_MIN_DY && dyPx > Math.abs(dxPx) * 1.5) {
        hardDrop();
      }
      draw();
    }
    touch = null;
  }
  board.addEventListener("pointerup", endTouch);
  board.addEventListener("pointercancel", endTouch);

  // --- Boot ----------------------------------------------------------------

  best = readBest();
  reset();
  draw();
  showOverlay("start");
})();
