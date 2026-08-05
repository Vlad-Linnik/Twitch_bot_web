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
  const engine = window.Game2048Engine;
  if (!board || !engine) return;

  const SIZE = engine.SIZE;
  const WIN_VALUE = engine.WIN_VALUE;

  // Anti-cheat: the run's moves are recorded and re-simulated server-side
  // (lib/gameReplay/2048.js) through this same engine. Bump RULES_VERSION here
  // AND there together whenever a gameplay rule changes - a mismatch makes the
  // server skip verification rather than mis-score an honest run.
  const RULES_VERSION = 1;
  // Direction rides in the opcode byte itself, no argument bytes - 2 bytes per
  // move, which is what keeps a long marathon inside its payload ceiling.
  const OPCODES = { left: 0, right: 1, up: 2, down: 3 };

  const run = window.SoloRun.create({
    gameKey: "2048",
    rulesVersion: RULES_VERSION,
    rootId: "g2048-leaderboard",
    listId: "g2048-lb-list",
    meWrapId: "g2048-lb-me",
    meRowId: "g2048-lb-me-row",
    // 2048 runs are open-ended, and a browser caps a keepalive:true beacon
    // body at 64kB - so the log is banked mid-run rather than sent whole.
    checkpoint: true,
  });
  const BEST_KEY = "the2048Best";
  const SAVE_KEY = "the2048Save";
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

  // --- Sound -------------------------------------------------------------------

  const SOUND_BASE = "/sounds/games/2048/";
  const SOUNDS = { merge: new Audio(SOUND_BASE + "merge.wav") };
  SOUNDS.merge.volume = 0.5;

  // Cloning the node lets overlapping plays (a move that merges several pairs
  // at once) stack instead of the next play cutting the previous one off.
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

  // --- In-progress board persistence ------------------------------------------
  // Lets a visitor close the tab mid-game and pick up exactly where they left
  // off later - only ever holds a "running"/"won" (mid keep-playing-prompt)
  // board, never a finished one (endGame() clears it - nothing to resume).
  // Tile identity doesn't need to survive the round trip (nothing animates
  // across a page load), so this only stores each cell's value, not tile ids.

  // The saved board is accompanied by the run's INPUT LOG. A restored position
  // can't be derived from a seed alone, so without the log a resumed game
  // would be unverifiable - the log is what lets the next session rebuild the
  // exact same position and keep the same run token.
  function saveGame() {
    try {
      const grid = cells.map((row) => row.map((t) => (t ? t.value : null)));
      const runState = run.serialize();
      localStorage.setItem(SAVE_KEY, JSON.stringify({ grid, score, won, state, run: runState }));
    } catch (_) {
      /* private mode etc. - the game just won't resume next time */
    }
  }

  function clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (_) {
      /* nothing to clean up if storage was never writable */
    }
  }

  // Defensive about shape - a saved game from an earlier version of this
  // script, or a hand-edited localStorage value, must never be able to crash
  // the board render below. Returns null for anything that doesn't check out.
  function loadSave() {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (_) {
      return null;
    }
    if (!raw) return null;
    try {
      const save = JSON.parse(raw);
      if (!save || (save.state !== "running" && save.state !== "won")) return null;
      if (!Array.isArray(save.grid) || save.grid.length !== SIZE) return null;
      for (const row of save.grid) {
        if (!Array.isArray(row) || row.length !== SIZE) return null;
        for (const v of row) {
          if (v !== null && !(Number.isInteger(v) && v > 0)) return null;
        }
      }
      if (!Number.isInteger(save.score) || save.score < 0) return null;
      return save;
    } catch (_) {
      return null;
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

  let cells; // cells[r][c] = tile object or null - RENDERING only
  let tiles; // Map id -> tile object {id, r, c, value}
  let tileEls; // Map id -> outer positioned element
  let nextId;
  let score, best;
  let won = false;
  let busy = false;
  let state = "idle"; // idle | running | won | over
  // Guards start() against re-entry: a repeat click on the overlay button
  // while the first click's run.begin() is still pending would otherwise
  // deal a second board on top of the first.
  let starting = false;
  // The authoritative board. `cells` above mirrors it with tile identities
  // attached so the DOM layer can animate; the RULES live only here, in the
  // shared engine, so the server replays exactly what the browser played.
  let engineState = null;

  function clearTiles() {
    cells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    tiles = new Map();
    tileEls = new Map();
    tilesLayer.textContent = "";
    nextId = 1;
  }

  // Materializes tile objects/elements for every occupied cell of the engine
  // grid. Used both for a fresh board and for a restored one - tile identity
  // never needs to survive either, since nothing animates across them.
  function buildTilesFromGrid() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const value = engineState.grid[r][c];
        if (!value) continue;
        const tile = { id: nextId++, r, c, value };
        cells[r][c] = tile;
        tiles.set(tile.id, tile);
        createTileEl(tile);
      }
    }
  }

  function addSpawnedTile(spawn) {
    const tile = { id: nextId++, r: spawn.r, c: spawn.c, value: spawn.value };
    cells[spawn.r][spawn.c] = tile;
    tiles.set(tile.id, tile);
    createTileEl(tile);
  }

  function reset() {
    clearTiles();
    score = 0;
    won = false;
    busy = false;
    // run.rng is the server's seeded stream while the run is ranked, plain
    // Math.random otherwise. Every draw must go through it - a bare
    // Math.random() here would desync the server's replay immediately.
    engineState = engine.createState(run.rng);
    buildTilesFromGrid();
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
  }

  function restoreFromSave(save) {
    clearTiles();
    buildTilesFromGrid();
    score = engineState.score;
    won = !!save.won;
    busy = false;
    updateHud();
    state = save.state;
    if (state === "won") showOverlay("won");
    else hideOverlay();
  }

  // Rebuilds a saved position by re-running the saved input log from the run's
  // seed. This is what makes a resumed game verifiable: the server can do the
  // exact same thing with the exact same log. Replaying through run.rng also
  // advances that stream to where the previous session left it, so play
  // continues from the right point.
  //
  // Returns false if the rebuild doesn't reproduce the saved board - a save
  // from an older version of the rules, or a hand-edited localStorage value.
  // The caller then discards it rather than trying to salvage it.
  function rebuildFromLog(save) {
    const rebuilt = engine.createState(run.rng);
    for (const ev of save.run.events) {
      const dir = Object.keys(OPCODES).find((k) => OPCODES[k] === ev.opcode);
      if (!dir) return false;
      engine.move(rebuilt, dir, run.rng);
    }
    if (rebuilt.score !== save.score) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (rebuilt.grid[r][c] !== (save.grid[r][c] || 0)) return false;
      }
    }
    engineState = rebuilt;
    return true;
  }

  // --- Movement ------------------------------------------------------------

  function move(dir) {
    if (state !== "running" || busy) return;

    // The engine decides everything: what slid where, what merged, what was
    // gained, and where the new tile spawned. A null result is a legal no-op
    // (pressing into a wall) and draws NOTHING from the rng - spawning on a
    // no-op would shift every later draw and rewrite the rest of the game.
    const result = engine.move(engineState, dir, run.rng);
    if (!result) return;

    // Recorded after the guards and after the no-op check, so the log holds
    // exactly the moves that changed the board - which is exactly what
    // lib/gameReplay/2048.js replays.
    run.record(OPCODES[dir]);

    const newCells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    const merges = []; // {primary, secondary, r, c, value}

    // Map the engine's coordinate-based description back onto tile objects so
    // the DOM layer can animate them.
    for (const op of result.ops) {
      if (op.type === "merge") {
        const primary = cells[op.primary[0]][op.primary[1]];
        const secondary = cells[op.secondary[0]][op.secondary[1]];
        primary.r = op.to[0];
        primary.c = op.to[1];
        primary.value = op.value;
        newCells[op.to[0]][op.to[1]] = primary;
        tiles.delete(secondary.id);
        merges.push({ primary, secondary, r: op.to[0], c: op.to[1], value: op.value });
      } else {
        const tile = cells[op.from[0]][op.from[1]];
        tile.r = op.to[0];
        tile.c = op.to[1];
        newCells[op.to[0]][op.to[1]] = tile;
      }
    }

    cells = newCells;
    score = engineState.score;
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
      if (merges.length > 0) playSound("merge");

      // The engine already placed this tile on the grid when the move was
      // applied; this only gives it a DOM presence, after the slide animation.
      if (result.spawn) addSpawnedTile(result.spawn);

      setTimeout(() => {
        busy = false;
        checkWinAndOver();
      }, SPAWN_MS);
    }, MOVE_MS);
  }

  function checkWinAndOver() {
    if (!won && engine.hasReachedWinValue(engineState)) {
      won = true;
      state = "won";
      showOverlay("won");
      saveGame();
      return;
    }
    if (engine.isGameOver(engineState)) {
      endGame();
    } else {
      saveGame();
    }
  }

  function endGame() {
    state = "over";
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    run.finish(score);
    showOverlay("over");
    clearSave(); // nothing left to resume once the game has actually ended
  }

  // --- Leaderboard / leave-page confirmation ---------------------------------
  // Both used to be copy-pasted into each of the six solo games; they now live
  // in soloRunClient.js, which also owns the run token and input recording.

  function gameInProgress() {
    return state === "running" || state === "won";
  }

  window.SoloRun.wireLeaveConfirm({
    dialogId: "g2048-leave-confirm-dialog",
    saveId: "g2048-leave-save",
    discardId: "g2048-leave-discard",
    cancelId: "g2048-leave-cancel",
    isInProgress: gameInProgress,
    canSave: () => run.canSubmit(),
    onSave: () => run.leaveBeacon(score),
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

  async function start() {
    if (starting) return;
    starting = true;
    try {
      // Register the run before the board is dealt: reset() below needs the
      // server's seed. begin() races itself against a short timeout and
      // resolves either way, so a slow or unreachable server costs a moment,
      // never the ability to play - the run is simply unranked then.
      run.abandon();
      await run.begin();
      reset();
      state = "running";
      hideOverlay();
      saveGame();
    } finally {
      starting = false;
    }
  }

  overlayButton.addEventListener("click", () => {
    if (state === "won") {
      // "Keep playing" continues the SAME run - don't touch the token.
      state = "running";
      hideOverlay();
      saveGame();
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
  const save = loadSave();
  // A save is only resumable if its run token can be re-adopted AND the saved
  // input log still rebuilds the saved board. Anything else - an old save from
  // before the run lifecycle, a save whose run has since expired, a
  // hand-edited localStorage value - is discarded rather than salvaged: an
  // unverifiable board is worse than a fresh one.
  if (save && save.run && run.resume(save.run) && rebuildFromLog(save)) {
    restoreFromSave(save);
  } else {
    if (save) clearSave();
    // The board behind the start overlay is decorative - the real one is dealt
    // by start(), once the run (and its seed) exists.
    reset();
    showOverlay("start");
  }
})();
