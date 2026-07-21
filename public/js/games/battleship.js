// /games/battleship - classic 1v1 Battleship, online-only via auto-matchmaking
// (realtime/quickMatchManager.js + lib/battleshipEngine.js). Connection/queue/
// ready-check plumbing comes from the shared quickMatchClient.js; rendering,
// placement input, and firing are all bespoke to this game (server fully
// authoritative, full re-render per state push - same philosophy as Durak).
//
// Placement is the "hologram" flow the feature request asked for: pick a ship
// from the fleet panel, a translucent ship follows the cursor, R rotates it,
// clicking drops it. Ships may not touch (adjacency rule, enforced here AND in
// the engine). Ship art is /img/games/battleship/ship-{4,3,2,1}.png, sliced
// from корабли.png; a ship sprite is a single absolutely-positioned overlay
// over the gap-less 10x10 grid (a vertical box that's rotated 90deg for a
// horizontal ship, so one upright sprite serves both orientations).
//
// Marks are three-valued (engine's "ранил/уничтожил/атакованный"): a wounded
// cell ("hit"), a destroyed ship's cells ("kill", the whole ship at once) plus
// the water auto-marked around a sunk ship ("miss"). Sounds: a shell splash on
// a miss, a small explosion on a hit, a crash on a kill.
(function () {
  "use strict";

  const root = document.getElementById("bs-root");
  if (!root || !window.createQuickMatchClient) return;

  const BOARD_SIZE = 10;
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]; // must match lib/battleshipEngine.js's FLEET
  const PALETTE_SIZES = [4, 3, 2, 1]; // distinct sizes, largest first
  const FLEET_COUNTS = { 4: 1, 3: 2, 2: 3, 1: 4 };
  const SHIP_SRC = {
    4: "/img/games/battleship/ship-4.png",
    3: "/img/games/battleship/ship-3.png",
    2: "/img/games/battleship/ship-2.png",
    1: "/img/games/battleship/ship-1.png",
  };

  const byId = (id) => document.getElementById(id);

  // --- Sound -----------------------------------------------------------------
  const SOUND_BASE = "/sounds/games/battleship/";
  const SOUNDS = {
    shot: new Audio(SOUND_BASE + "shot.wav"), // a miss - shell into the water
    hit: new Audio(SOUND_BASE + "hit.wav"), // a wounding hit
    kill: new Audio(SOUND_BASE + "kill.wav"), // a ship destroyed
  };
  for (const a of Object.values(SOUNDS)) a.volume = 0.45;
  function playSound(name) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume * (window.gameVolume ? window.gameVolume.get() : 1);
      node.play().catch(() => {});
    } catch (_) {
      /* audio blocked/unsupported - the game keeps working silently */
    }
  }

  const client = window.createQuickMatchClient(root.dataset.wsPath);
  window.wireQuickMatchReadyCheck(client);
  window.wireQuickMatchQueueDisplay(client, {
    countEl: byId("bs-queue-count"),
    timeEl: byId("bs-queue-time"),
  });
  window.wireQuickMatchLobby(client);

  const screens = { idle: byId("bs-screen-idle"), queued: byId("bs-screen-queued"), game: byId("bs-screen-game") };
  const placementPanel = byId("bs-placement");
  const battlePanel = byId("bs-battle");
  const resultOverlay = byId("bs-result");
  const resultTitle = byId("bs-result-title");
  const resultBody = byId("bs-result-body");
  const opponentBanner = byId("bs-opponent-banner");
  const statusEl = byId("bs-status");
  const timerEl = byId("bs-timer");
  const paletteEl = byId("bs-ship-palette");
  const readyBtn = byId("bs-ready-btn");
  const rotateBtn = byId("bs-rotate");
  const undoBtn = byId("bs-undo");
  const placementGrid = byId("bs-placement-grid");
  const myBoardGrid = byId("bs-my-board");
  const oppBoardGrid = byId("bs-opp-board");
  const resignBtn = byId("bs-resign");
  const spectatePanel = byId("bs-spectate");
  const spectateWaitingEl = byId("bs-spectate-waiting");
  const spectateBoardsEl = byId("bs-spectate-boards");
  const spectateNameEls = [byId("bs-spectate-name-0"), byId("bs-spectate-name-1")];
  const spectateBoardEls = [byId("bs-spectate-board-0"), byId("bs-spectate-board-1")];

  let spectating = false;
  let spectatePlayerNames = null;

  window.wireQuickMatchSpectating(client, {
    badgeEl: byId("bs-spectating-badge"),
    stopBtn: byId("bs-stop-watching-btn"),
    onExit: () => {
      spectating = false;
      placementPanel.hidden = true;
      battlePanel.hidden = true;
      spectatePanel.hidden = true;
      showScreen("idle");
    },
  });

  let youAreSeat = null;
  let orientation = "horizontal"; // horizontal | vertical
  let selectedSize = 4;
  let placedShips = []; // { size, cells, dir }
  let remaining = Object.assign({}, FLEET_COUNTS);
  let hoverCell = null;
  let placementSubmitted = false;
  let placementCells = null; // 2D array of cell buttons
  let lastBattleState = null;
  let prevShots = null; // for the sound diff

  function showScreen(name) {
    for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  }

  // --- Ship / mark overlays --------------------------------------------------
  // The board grid is gap-less 10x10, so a cell spans exactly 10% x 10% and
  // overlays can be positioned in plain percentages. A ship sprite is upright
  // art; a horizontal ship reuses the same art rotated 90deg about the footprint
  // centre (a horizontal footprint is a vertical one transposed).

  function footprintStyle(r, c, size, dir) {
    const cell = 10;
    if (dir !== "horizontal") {
      return { left: c * cell + "%", top: r * cell + "%", width: cell + "%", height: size * cell + "%", transform: "none" };
    }
    const cx = (c + size / 2) * cell;
    const cy = (r + 0.5) * cell;
    const w = cell;
    const h = size * cell;
    return { left: cx - w / 2 + "%", top: cy - h / 2 + "%", width: w + "%", height: h + "%", transform: "rotate(90deg)" };
  }

  function makeShipOverlay(size, r, c, dir, cls) {
    const wrap = document.createElement("div");
    wrap.className = "bs-ship-wrap " + cls;
    Object.assign(wrap.style, footprintStyle(r, c, size, dir));
    const img = document.createElement("img");
    img.src = SHIP_SRC[size];
    img.className = "bs-ship-img";
    img.alt = "";
    img.draggable = false;
    wrap.appendChild(img);
    return wrap;
  }

  function makeMark(r, c, kind) {
    const el = document.createElement("div");
    el.className = "bs-mark bs-mark-" + kind;
    el.style.left = c * 10 + "%";
    el.style.top = r * 10 + "%";
    return el;
  }

  // A ship arrives from the server as a bare cell array (myShips / sunk ships) -
  // recover its size/anchor/orientation for rendering.
  function shipInfo(cells) {
    const size = cells.length;
    const rows = cells.map((x) => x[0]);
    const cols = cells.map((x) => x[1]);
    const dir = size > 1 && rows.every((x) => x === rows[0]) ? "horizontal" : "vertical";
    return { size, r: Math.min(...rows), c: Math.min(...cols), dir };
  }

  // --- Placement -------------------------------------------------------------

  function shipCellsFrom(row, col, size, dir) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push(dir === "horizontal" ? [row, col + i] : [row + i, col]);
    return cells;
  }

  // Placed cells AND all their neighbours - a new ship may not fall on any of
  // these (that covers both overlap and the no-touching adjacency rule).
  function blockedCells() {
    const s = new Set();
    for (const ship of placedShips) {
      for (const [r, c] of ship.cells) {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s.add(r + dr + "," + (c + dc));
      }
    }
    return s;
  }

  function inBounds(cells) {
    return cells.every(([r, c]) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE);
  }

  function isValidPlacement(cells) {
    if (!inBounds(cells)) return false;
    const blocked = blockedCells();
    return !cells.some(([r, c]) => blocked.has(r + "," + c));
  }

  function totalRemaining() {
    return PALETTE_SIZES.reduce((n, s) => n + remaining[s], 0);
  }

  function largestRemaining() {
    return PALETTE_SIZES.find((s) => remaining[s] > 0) || null;
  }

  function buildPlacementGrid() {
    placementGrid.textContent = "";
    placementCells = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      placementCells.push([]);
      for (let c = 0; c < BOARD_SIZE; c++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bs-cell";
        b.dataset.r = r;
        b.dataset.c = c;
        b.addEventListener("click", () => handlePlaceClick(r, c));
        b.addEventListener("mouseenter", () => {
          hoverCell = { r, c };
          renderGhost();
        });
        placementCells[r].push(b);
        placementGrid.appendChild(b);
      }
    }
    placementGrid.addEventListener("mouseleave", () => {
      hoverCell = null;
      renderGhost();
    });
  }

  function clearOverlays(container, cls) {
    container.querySelectorAll("." + cls).forEach((el) => el.remove());
  }

  function renderPlacedShips() {
    clearOverlays(placementGrid, "bs-ov-ship");
    for (const ship of placedShips) {
      // cells[0] is the anchor (shipCellsFrom starts there) for both orientations.
      placementGrid.appendChild(makeShipOverlay(ship.size, ship.cells[0][0], ship.cells[0][1], ship.dir, "bs-ship-mine bs-ov-ship"));
    }
  }

  function renderGhost() {
    clearOverlays(placementGrid, "bs-ov-ghost");
    if (placementSubmitted || !hoverCell || !selectedSize || remaining[selectedSize] <= 0) return;
    const cells = shipCellsFrom(hoverCell.r, hoverCell.c, selectedSize, orientation);
    if (!inBounds(cells)) return; // nothing to preview off the edge
    const ok = isValidPlacement(cells);
    const el = makeShipOverlay(selectedSize, hoverCell.r, hoverCell.c, orientation, "bs-ov-ghost " + (ok ? "bs-ghost-ok" : "bs-ghost-bad"));
    placementGrid.appendChild(el);
  }

  function renderPalette() {
    paletteEl.textContent = "";
    for (const size of PALETTE_SIZES) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bs-palette-item";
      if (remaining[size] <= 0) row.classList.add("bs-palette-done");
      if (size === selectedSize && remaining[size] > 0) row.classList.add("bs-palette-selected");
      row.disabled = remaining[size] <= 0 || placementSubmitted;

      const ship = document.createElement("span");
      ship.className = "bs-palette-ship";
      for (let i = 0; i < size; i++) {
        const cell = document.createElement("span");
        cell.className = "bs-palette-cell";
        ship.appendChild(cell);
      }
      const count = document.createElement("span");
      count.className = "bs-palette-count";
      count.textContent = "×" + remaining[size];

      row.appendChild(ship);
      row.appendChild(count);
      row.addEventListener("click", () => {
        if (remaining[size] <= 0 || placementSubmitted) return;
        selectedSize = size;
        renderPalette();
        renderGhost();
      });
      paletteEl.appendChild(row);
    }
  }

  function flashInvalid(r, c) {
    const el = placementCells[r] && placementCells[r][c];
    if (!el) return;
    el.classList.remove("bs-cell-invalid");
    void el.offsetWidth;
    el.classList.add("bs-cell-invalid");
  }

  function updateReadyBtn() {
    const done = totalRemaining() === 0 && !placementSubmitted;
    readyBtn.disabled = !done;
  }

  function handlePlaceClick(r, c) {
    if (placementSubmitted) return;
    if (!selectedSize || remaining[selectedSize] <= 0) {
      selectedSize = largestRemaining();
      renderPalette();
      if (!selectedSize) return;
    }
    const cells = shipCellsFrom(r, c, selectedSize, orientation);
    if (!isValidPlacement(cells)) {
      flashInvalid(r, c);
      return;
    }
    placedShips.push({ size: selectedSize, cells, dir: orientation });
    remaining[selectedSize]--;
    if (remaining[selectedSize] <= 0) selectedSize = largestRemaining();
    renderPlacedShips();
    renderPalette();
    renderGhost();
    updateReadyBtn();
  }

  function resetPlacement() {
    placedShips = [];
    remaining = Object.assign({}, FLEET_COUNTS);
    placementSubmitted = false;
    hoverCell = null;
    selectedSize = 4;
    renderPlacedShips();
    renderPalette();
    renderGhost();
    updateReadyBtn();
  }

  function undoLast() {
    if (placementSubmitted || placedShips.length === 0) return;
    const last = placedShips.pop();
    remaining[last.size]++;
    selectedSize = last.size;
    renderPlacedShips();
    renderPalette();
    renderGhost();
    updateReadyBtn();
  }

  // Mirrors lib/battleshipEngine.js's randomFleet (sizes + adjacency).
  function randomFleet() {
    for (let attempt = 0; attempt < 500; attempt++) {
      const ships = [];
      const occupied = new Set();
      let ok = true;
      for (const size of FLEET) {
        let placed = false;
        for (let t = 0; t < 300 && !placed; t++) {
          const dir = Math.random() < 0.5 ? "horizontal" : "vertical";
          const row = Math.floor(Math.random() * BOARD_SIZE);
          const col = Math.floor(Math.random() * BOARD_SIZE);
          const cells = shipCellsFrom(row, col, size, dir);
          if (!inBounds(cells)) continue;
          if (cells.some(([r, c]) => occupied.has(r + "," + c))) continue;
          ships.push({ size, cells, dir });
          for (const [r, c] of cells) {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) occupied.add(r + dr + "," + (c + dc));
          }
          placed = true;
        }
        if (!placed) {
          ok = false;
          break;
        }
      }
      if (ok) return ships;
    }
    return null;
  }

  function autoPlace() {
    if (placementSubmitted) return;
    const fleet = randomFleet();
    if (!fleet) return;
    placedShips = fleet;
    remaining = { 4: 0, 3: 0, 2: 0, 1: 0 };
    selectedSize = null;
    renderPlacedShips();
    renderPalette();
    renderGhost();
    updateReadyBtn();
  }

  function toggleOrientation() {
    orientation = orientation === "horizontal" ? "vertical" : "horizontal";
    if (rotateBtn) rotateBtn.textContent = orientation === "horizontal" ? rotateBtn.dataset.horizontal : rotateBtn.dataset.vertical;
    renderGhost();
  }

  function submitPlacement() {
    if (placementSubmitted || totalRemaining() !== 0) return;
    placementSubmitted = true;
    renderGhost();
    renderPalette();
    updateReadyBtn();
    client.send("move", { move: { type: "place", ships: placedShips.map((s) => ({ cells: s.cells })) } });
    statusEl.textContent = statusEl.dataset.waitingOpponent;
  }

  readyBtn?.addEventListener("click", submitPlacement);
  undoBtn?.addEventListener("click", undoLast);
  rotateBtn?.addEventListener("click", toggleOrientation);
  byId("bs-auto-place")?.addEventListener("click", autoPlace);
  byId("bs-reset-placement")?.addEventListener("click", resetPlacement);

  // R (or Cyrillic К) rotates while placing.
  document.addEventListener("keydown", (e) => {
    if (placementSubmitted || screens.game.hidden || placementPanel.hidden) return;
    if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") {
      e.preventDefault();
      toggleOrientation();
    }
  });

  // --- Battle ----------------------------------------------------------------

  function handleFireClick(r, c) {
    if (!lastBattleState || lastBattleState.phase !== "battle") return;
    if (lastBattleState.turnSeat !== youAreSeat) return;
    if (lastBattleState.opponentShots && lastBattleState.opponentShots[r + "," + c]) return; // already fired
    client.send("move", { move: { type: "fire", cell: [r, c] } });
  }

  // ships: array of cell-arrays to draw as own sprites; sunkShips: enemy sprites
  // revealed on sinking; shots: cellKey -> miss|hit|kill; onCellClick optional.
  function renderBoard(container, ships, shots, sunkShips, onCellClick) {
    container.textContent = "";
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bs-cell";
        if (shots[r + "," + c] === "miss") b.classList.add("bs-cell-miss");
        if (onCellClick) b.addEventListener("click", () => onCellClick(r, c));
        else b.classList.add("bs-cell-static");
        container.appendChild(b);
      }
    }
    for (const cells of ships) {
      const info = shipInfo(cells);
      container.appendChild(makeShipOverlay(info.size, info.r, info.c, info.dir, "bs-ship-mine"));
    }
    for (const cells of sunkShips || []) {
      const info = shipInfo(cells);
      container.appendChild(makeShipOverlay(info.size, info.r, info.c, info.dir, "bs-ship-enemy bs-ship-dead"));
    }
    for (const key in shots) {
      const v = shots[key];
      if (v === "hit" || v === "kill") {
        const [r, c] = key.split(",").map(Number);
        container.appendChild(makeMark(r, c, v));
      }
    }
  }

  function renderBattle(state) {
    statusEl.textContent = state.turnSeat === youAreSeat ? statusEl.dataset.yourTurn : statusEl.dataset.opponentTurn;
    renderBoard(myBoardGrid, (state.myShips || []).map((s) => s.cells), state.myShots || {}, null, null);
    renderBoard(oppBoardGrid, [], state.opponentShots || {}, state.opponentSunkShips || [], handleFireClick);
  }

  // Fair-view spectator render: both boards use the SAME "shots + sunk ships
  // only, never an unsunk ship's cells" treatment renderBoard already gives a
  // seated player's view of their opponent - just applied to both sides at
  // once, since a spectator has no seat of their own to see the truth for.
  // The server's serializeForSpectator (lib/battleshipEngine.js) is what
  // actually enforces this - this function only ever draws what it's given.
  function renderSpectatePhase(state) {
    const waiting = state.phase === "placement";
    spectateWaitingEl.hidden = !waiting;
    spectateBoardsEl.hidden = waiting;
    if (waiting) return;
    statusEl.textContent = statusEl.dataset.spectateTurnTpl.replace("{{name}}", spectatePlayerNames[state.turnSeat]);
    for (let seat = 0; seat < 2; seat++) {
      spectateNameEls[seat].textContent = spectatePlayerNames[seat];
      renderBoard(spectateBoardEls[seat], [], state.boards[seat].shots, state.boards[seat].sunkShips, null);
    }
  }

  // One sound per state update, keyed to the most severe newly-marked cell
  // across BOTH boards (kill > hit > miss), so being attacked is audible too.
  function playForDiff(state) {
    const cur = {};
    for (const k in state.myShots || {}) cur["m" + k] = state.myShots[k];
    for (const k in state.opponentShots || {}) cur["o" + k] = state.opponentShots[k];
    if (prevShots === null) {
      prevShots = cur;
      return;
    }
    let sev = 0;
    for (const k in cur) {
      if (prevShots[k] !== cur[k]) {
        const s = cur[k] === "kill" ? 3 : cur[k] === "hit" ? 2 : 1;
        if (s > sev) sev = s;
      }
    }
    prevShots = cur;
    if (sev === 3) playSound("kill");
    else if (sev === 2) playSound("hit");
    else if (sev === 1) playSound("shot");
  }

  // --- Phase countdown (server-authoritative deadline) -----------------------
  let deadlineAt = null;
  let deadlineTag = null;
  let timerHandle = null;

  function renderTimer() {
    if (!timerEl) return;
    if (deadlineAt == null) {
      timerEl.hidden = true;
      return;
    }
    timerEl.hidden = false;
    const ms = Math.max(0, deadlineAt - Date.now());
    const total = Math.floor(ms / 1000);
    const label = deadlineTag === "placement" ? timerEl.dataset.placementLabel : timerEl.dataset.battleLabel;
    timerEl.textContent = label + " " + Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    timerEl.classList.toggle("bs-timer-urgent", ms < 15000);
  }

  function setDeadline(d) {
    if (!d) {
      deadlineAt = null;
      deadlineTag = null;
      if (timerHandle) {
        clearInterval(timerHandle);
        timerHandle = null;
      }
      renderTimer();
      return;
    }
    deadlineAt = d.at;
    deadlineTag = d.tag;
    renderTimer();
    if (!timerHandle) timerHandle = setInterval(renderTimer, 250);
  }

  // --- Message handling ------------------------------------------------------

  client.on("matched", (msg) => {
    youAreSeat = msg.youAreSeat;
    orientation = "horizontal";
    prevShots = null;
    lastBattleState = null;
    showScreen("game");
    placementPanel.hidden = false;
    battlePanel.hidden = true;
    spectatePanel.hidden = true;
    resultOverlay.hidden = true;
    opponentBanner.hidden = true;
    if (rotateBtn) rotateBtn.textContent = rotateBtn.dataset.horizontal;
    buildPlacementGrid();
    resetPlacement();
    statusEl.textContent = statusEl.dataset.placementHint;
    setDeadline(msg.deadline);
    resignBtn.hidden = false;
  });

  client.on("state", (msg) => {
    setDeadline(msg.deadline);
    const state = msg.state;
    if (msg.spectating) {
      if (!spectating) {
        spectating = true;
        spectatePlayerNames = msg.players.map((p) => p.displayName);
        showScreen("game");
        resultOverlay.hidden = true;
        opponentBanner.hidden = true;
        placementPanel.hidden = true;
        battlePanel.hidden = true;
        spectatePanel.hidden = false;
        resignBtn.hidden = true;
      }
      renderSpectatePhase(state);
      return;
    }
    if (state.phase !== "battle" && state.phase !== "finished") return; // still placing
    if (!placementPanel.hidden) {
      placementPanel.hidden = true;
      battlePanel.hidden = false;
    }
    lastBattleState = state;
    renderBattle(state);
    playForDiff(state);
  });

  client.on("gameOver", (msg) => {
    setDeadline(null);
    const won = msg.result === "decided" && msg.winnerSeat === youAreSeat;
    const draw = msg.result === "draw";
    resultTitle.textContent = draw ? resultTitle.dataset.draw : won ? resultTitle.dataset.win : resultTitle.dataset.lose;
    resultBody.textContent =
      typeof msg.ratingDelta === "number"
        ? resultBody.dataset.ratingTpl.replace("{{delta}}", (msg.ratingDelta >= 0 ? "+" : "") + msg.ratingDelta)
        : "";
    resultOverlay.hidden = false;
    lastBattleState = null;
  });

  client.on("opponentDisconnected", () => {
    opponentBanner.hidden = false;
  });
  client.on("opponentReconnected", () => {
    opponentBanner.hidden = true;
  });
  client.on("matchCancelled", () => showScreen("idle"));
  client.on("queued", () => showScreen("queued"));
  client.on("error", (msg) => console.error("[battleship] server error:", msg.error));

  byId("bs-queue-button")?.addEventListener("click", () => {
    showScreen("queued");
    client.send("queue");
  });
  byId("bs-cancel-queue")?.addEventListener("click", () => {
    client.send("cancelQueue");
    showScreen("idle");
  });
  byId("bs-resign")?.addEventListener("click", () => client.send("resign"));
  byId("bs-play-again")?.addEventListener("click", () => showScreen("idle"));

  showScreen("idle");
  client.connect();
})();
