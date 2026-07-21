// /games/backgammon - online 1v1 long backgammon (long nardy) via auto-
// matchmaking (realtime/quickMatchManager.js + lib/backgammonEngine.js).
// Server fully authoritative and there's no hidden info in backgammon at
// all, but this client still never re-derives legality itself
// (lib/ is server-only, no bundler in this repo to share it) - it infers
// which die a click pair implies, sends the move, and lets the server accept
// or reject it, same "dumb renderer, server is the referee" philosophy as
// every other realtime game here.
(function () {
  "use strict";

  const root = document.getElementById("bg-root");
  if (!root || !window.createQuickMatchClient) return;

  const client = window.createQuickMatchClient(root.dataset.wsPath);
  window.wireQuickMatchQueueDisplay(client, {
    countEl: document.getElementById("bg-queue-count"),
    timeEl: document.getElementById("bg-queue-time"),
  });

  const screens = {
    idle: document.getElementById("bg-screen-idle"),
    queued: document.getElementById("bg-screen-queued"),
    game: document.getElementById("bg-screen-game"),
  };
  const quadTL = document.getElementById("bg-quad-tl");
  const quadTR = document.getElementById("bg-quad-tr");
  const quadBL = document.getElementById("bg-quad-bl");
  const quadBR = document.getElementById("bg-quad-br");
  const offEl0 = document.getElementById("bg-off-0");
  const offEl1 = document.getElementById("bg-off-1");
  const offZoneEl = document.getElementById("bg-bear-off-zone");
  const diceEl = document.getElementById("bg-dice");
  const statusEl = document.getElementById("bg-status");
  const rollButton = document.getElementById("bg-roll");
  const turnValueEl = document.getElementById("bg-turn-value");
  const opponentBanner = document.getElementById("bg-opponent-banner");
  const resultOverlay = document.getElementById("bg-result");
  const resultTitle = document.getElementById("bg-result-title");
  const resultBody = document.getElementById("bg-result-body");
  const timerEl = document.getElementById("bg-timer");
  const colorBadge = document.getElementById("bg-color-badge");

  let youAreSeat = 0;
  let latestState = null;
  let selectedFrom = null; // point index (0-23) or null

  // Long nardy travel-position math, hand-kept in sync with
  // lib/backgammonEngine.js's copy (no bundler/shared code between server
  // lib/ and client public/js/ in this repo). travelPos(seat, idx) = 0 at
  // that seat's own head/start point, 23 at the last point before bearing
  // off; travelIdx() is its inverse. Seat 0 heads from point 24 (index 23)
  // with no wraparound; seat 1 heads from point 12 (index 11) and wraps
  // around past point 1/24 to reach its home.
  const TRAVEL_START = [23, 11];
  function travelPos(seat, idx) {
    return (((TRAVEL_START[seat] - idx) % 24) + 24) % 24;
  }
  function travelIdx(seat, pos) {
    return (((TRAVEL_START[seat] - pos) % 24) + 24) % 24;
  }

  // A stack shows real checkers up to this many; beyond that, the top
  // checker also carries the actual count so tall stacks stay readable
  // without falling back to "just a number" for every point.
  const VISIBLE_MAX = 5;

  // --- Sound (same cloneNode()-per-play pattern as the other on-site games,
  // e.g. durak-multiplayer.js, so overlapping plays layer instead of cutting
  // each other off). "move" has 3 variants and picks one at random per play so
  // repeated checker moves don't sound mechanically identical.
  const SOUND_BASE = "/sounds/games/backgammon/";
  const DICE_SOUND = new Audio(SOUND_BASE + "dice.wav");
  DICE_SOUND.volume = 0.5;
  const MOVE_SOUNDS = ["chess-pieces1.wav", "chess-pieces2.wav", "chess-pieces3.wav"].map((f) => {
    const a = new Audio(SOUND_BASE + f);
    a.volume = 0.5;
    return a;
  });

  function playSound(base) {
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume;
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

  function playDiceSound() {
    playSound(DICE_SOUND);
  }

  function playMoveSound() {
    playSound(MOVE_SOUNDS[Math.floor(Math.random() * MOVE_SOUNDS.length)]);
  }

  // --- Doubles dice reveal (server rolls and sends all 4 values for a double
  // at once, but showing 4 dice pop in simultaneously reads as confusing -
  // real backgammon shows 2 dice, THEN adds 2 more once the double is seen).
  // This stages the client-side reveal only; legality/board state already
  // reflect all 4 dice immediately, this purely delays how bg-dice fills in.
  const DOUBLES_REVEAL_DELAY_MS = 700;
  let doublesRevealTimer = null;
  let diceOverride = null; // when set, render() shows this instead of state.movesRemaining

  function renderDice(values) {
    diceEl.textContent = "";
    for (const die of values) {
      const d = document.createElement("span");
      d.className = "bg-die";
      d.textContent = die;
      diceEl.appendChild(d);
    }
  }

  function showScreen(name) {
    for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  }

  // Board quadrants are assigned by TRAVEL position relative to the viewing
  // seat, not by fixed absolute point ranges - since travelPos() is already
  // seat-relative, this makes EVERY viewer see their own head point bottom-
  // left and their own home top-right, without any CSS flip/rotation: BL =
  // travel positions 0-5 (own start), BR = 6-11, TL = 12-17, TR = 18-23 (own
  // home). Points within a quadrant are ordered by ascending travel position
  // left to right.
  function quadrantIndices(seat, startPos) {
    const out = [];
    for (let p = startPos; p < startPos + 6; p++) out.push(travelIdx(seat, p));
    return out;
  }

  function pointEl(idx) {
    return root.querySelector('[data-point="' + idx + '"]');
  }

  function buildBoard() {
    quadTL.textContent = "";
    quadTR.textContent = "";
    quadBL.textContent = "";
    quadBR.textContent = "";
    fillQuad(quadBL, quadrantIndices(youAreSeat, 0), "bottom", false);
    fillQuad(quadBR, quadrantIndices(youAreSeat, 6), "bottom", true);
    fillQuad(quadTL, quadrantIndices(youAreSeat, 12), "top", false);
    fillQuad(quadTR, quadrantIndices(youAreSeat, 18), "top", true);
  }

  // `shiftShade` flips which shade starts the quad, purely so triangles right
  // next to the bar don't happen to match the color of the one across from
  // them - cosmetic only, no gameplay meaning.
  function fillQuad(quad, indices, orientation, shiftShade) {
    indices.forEach((idx, i) => {
      const shade = (i % 2 === 0) !== shiftShade ? "light" : "dark";
      quad.appendChild(makePointColumn(idx, orientation, shade));
    });
  }

  function makePointColumn(idx, orientation, shade) {
    const col = document.createElement("button");
    col.type = "button";
    col.className = "bg-point bg-point-" + orientation + " bg-point-" + shade;
    col.dataset.point = String(idx);
    col.addEventListener("click", () => handlePointClick(idx));
    return col;
  }

  // Renders `count` (signed: positive = seat 0/white, negative = seat
  // 1/black) as real overlapping checker circles into `container`, capping
  // the number actually drawn at VISIBLE_MAX and putting the true total on
  // the last one once a stack exceeds that.
  function appendCheckers(container, count) {
    if (!count) return;
    const seat = count > 0 ? 0 : 1;
    const total = Math.abs(count);
    const visible = Math.min(total, VISIBLE_MAX);
    for (let i = 0; i < visible; i++) {
      const checker = document.createElement("div");
      checker.className = "bg-checker-stack " + (seat === 0 ? "bg-checker-p0" : "bg-checker-p1");
      if (i === visible - 1 && total > VISIBLE_MAX) {
        const badge = document.createElement("span");
        badge.className = "bg-checker-count";
        badge.textContent = String(total);
        checker.appendChild(badge);
      }
      container.appendChild(checker);
    }
  }

  // Is `to` (a point index, "bar", or "off") a destination the currently
  // selected checker can legally reach with the dice on this turn? Purely a
  // rendering hint - lib/backgammonEngine.js's serializeForSeat() already
  // filters legalMoves down to whichever seat asked, so there's nothing to
  // re-derive here, just a lookup.
  function isLegalTarget(to) {
    if (selectedFrom == null || !latestState || !latestState.legalMoves) return false;
    return latestState.legalMoves.some((m) => String(m.from) === String(selectedFrom) && String(m.to) === String(to));
  }

  function renderPoint(idx, count) {
    const el = pointEl(idx);
    if (!el) return;
    el.textContent = "";
    el.classList.toggle("bg-point-selected", selectedFrom === idx);
    el.classList.toggle("bg-point-target", isLegalTarget(idx));
    appendCheckers(el, count);
  }

  function render(state) {
    latestState = state;
    for (let i = 0; i < 24; i++) renderPoint(i, state.points[i]);

    if (offZoneEl) offZoneEl.classList.toggle("bg-bear-off-target", isLegalTarget("off"));

    offEl0.textContent = state.borneOff[youAreSeat];
    offEl1.textContent = state.borneOff[youAreSeat === 0 ? 1 : 0];

    renderDice(diceOverride || state.movesRemaining);

    turnValueEl.textContent = state.turnNumber;

    const myTurn = state.turnSeat === youAreSeat;
    rollButton.hidden = !(myTurn && state.turnPhase === "roll");

    if (myTurn) {
      statusEl.textContent = state.turnPhase === "roll" ? statusEl.dataset.yourRoll : statusEl.dataset.yourMove;
    } else {
      statusEl.textContent = statusEl.dataset.opponentTurn;
    }
  }

  // Backgammon has no hidden info, so a die value is always mechanically
  // derivable from the (from, to) pair the player clicked - this just
  // reverses lib/backgammonEngine.js's own from/die -> to formulas (via the
  // same travel-position math) rather than asking the player to pick a die
  // first.
  function inferDie(from, to) {
    const state = latestState;
    if (!state) return null;
    if (to === "off") {
      const exact = 24 - travelPos(youAreSeat, from);
      if (state.movesRemaining.includes(exact)) return exact;
      // Oversized-die bear-off: fall back to the largest remaining die and
      // let the server confirm this is actually the farthest-back checker.
      return Math.max(...state.movesRemaining);
    }
    return travelPos(youAreSeat, to) - travelPos(youAreSeat, from);
  }

  function handlePointClick(idx) {
    if (!latestState || latestState.turnSeat !== youAreSeat || latestState.turnPhase !== "move") return;
    if (selectedFrom === null) {
      const owner = latestState.points[idx] > 0 ? 0 : latestState.points[idx] < 0 ? 1 : null;
      if (owner !== youAreSeat) return;
      selectedFrom = idx;
      render(latestState);
      return;
    }
    sendMove(selectedFrom, idx);
  }

  offZoneEl?.addEventListener("click", () => {
    if (selectedFrom === null) return;
    sendMove(selectedFrom, "off");
  });

  function sendMove(from, to) {
    const die = inferDie(from, to);
    selectedFrom = null;
    if (die == null) return;
    client.send("move", { move: { type: "move", from, to, die } });
  }

  // --- Per-decision countdown (server-authoritative deadline, same pattern
  // as battleship.js's phase timer). ------------------------------------
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

  // Board/dice snapshots from the last rendered state, so a "state" message
  // can tell (a) a checker actually moved (board changed - play the move
  // sound, whether it was our move or the opponent's) from (b) a fresh roll
  // just landed (dice changed and no move has consumed any of it yet - play
  // the dice sound, and if it's a double, stage the reveal). Reset to null on
  // "matched" so the very first snapshot of a new game never fires a sound.
  let lastBoardKey = null;
  let lastDiceKey = null;

  function boardKey(state) {
    return JSON.stringify([state.points, state.borneOff]);
  }

  function handleStateUpdate(state) {
    const boardKeyNow = boardKey(state);
    if (lastBoardKey !== null && boardKeyNow !== lastBoardKey) playMoveSound();
    lastBoardKey = boardKeyNow;

    const diceKeyNow = JSON.stringify(state.dice);
    const isFreshRoll = state.dice.length > 0 && state.movesRemaining.length === state.dice.length && diceKeyNow !== lastDiceKey;
    lastDiceKey = diceKeyNow;

    if (doublesRevealTimer) {
      clearTimeout(doublesRevealTimer);
      doublesRevealTimer = null;
    }
    diceOverride = null;

    if (isFreshRoll) {
      playDiceSound();
      if (state.dice.length === 4) {
        diceOverride = state.dice.slice(0, 2);
        doublesRevealTimer = setTimeout(() => {
          diceOverride = null;
          doublesRevealTimer = null;
          renderDice(latestState.movesRemaining);
          playDiceSound();
        }, DOUBLES_REVEAL_DELAY_MS);
      }
    }

    render(state);
  }

  client.on("matched", (msg) => {
    youAreSeat = msg.youAreSeat;
    selectedFrom = null;
    lastBoardKey = null;
    lastDiceKey = null;
    diceOverride = null;
    if (doublesRevealTimer) {
      clearTimeout(doublesRevealTimer);
      doublesRevealTimer = null;
    }
    showScreen("game");
    resultOverlay.hidden = true;
    opponentBanner.hidden = true;
    buildBoard();
    if (colorBadge) {
      colorBadge.hidden = false;
      colorBadge.textContent = youAreSeat === 0 ? colorBadge.dataset.p0 : colorBadge.dataset.p1;
      colorBadge.className = "px-2.5 py-1 rounded-md text-sm font-medium " + (youAreSeat === 0 ? "bg-neutral-100 text-neutral-900" : "bg-neutral-950 text-neutral-100 border border-neutral-700");
    }
    setDeadline(msg.deadline);
  });

  client.on("state", (msg) => {
    setDeadline(msg.deadline);
    handleStateUpdate(msg.state);
  });

  client.on("gameOver", (msg) => {
    setDeadline(null);
    const won = msg.result === "decided" && msg.winnerSeat === youAreSeat;
    resultTitle.textContent = won ? resultTitle.dataset.win : resultTitle.dataset.lose;
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
  client.on("error", (msg) => console.error("[backgammon] server error:", msg.error));

  rollButton?.addEventListener("click", () => {
    client.send("move", { move: { type: "roll" } });
  });

  document.getElementById("bg-queue-button")?.addEventListener("click", () => {
    showScreen("queued");
    client.send("queue");
  });
  document.getElementById("bg-cancel-queue")?.addEventListener("click", () => {
    client.send("cancelQueue");
    showScreen("idle");
  });
  document.getElementById("bg-resign")?.addEventListener("click", () => {
    client.send("resign");
  });
  document.getElementById("bg-play-again")?.addEventListener("click", () => {
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
