// /games/pong - online 1v1 air hockey/Pong via auto-matchmaking (realtime/
// quickMatchManager.js's TICK mode + lib/pongEngine.js). The server is fully
// physics-authoritative (ticks ~30/s); this file only sends paddle-direction
// intent on change and renders whatever "tick"/"state" pushes it receives -
// same "dumb renderer" philosophy as every other realtime game client here.
(function () {
  "use strict";

  const root = document.getElementById("pong-root");
  if (!root || !window.createQuickMatchClient) return;

  // Must match lib/pongEngine.js's constants - server-only module, never
  // shipped to the browser (no bundler in this repo), so these are a
  // deliberate, documented duplicate purely for rendering scale.
  const COURT_WIDTH = 400;
  const COURT_HEIGHT = 300;
  const PADDLE_WIDTH = 10;
  const PADDLE_HEIGHT = 60;
  const BALL_RADIUS = 6;
  const TARGET_SCORE = 7;

  const client = window.createQuickMatchClient(root.dataset.wsPath);
  window.wireQuickMatchQueueDisplay(client, {
    countEl: document.getElementById("pong-queue-count"),
    timeEl: document.getElementById("pong-queue-time"),
  });

  const screens = {
    idle: document.getElementById("pong-screen-idle"),
    queued: document.getElementById("pong-screen-queued"),
    game: document.getElementById("pong-screen-game"),
  };
  const canvas = document.getElementById("pong-canvas");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("pong-score");
  const opponentBanner = document.getElementById("pong-opponent-banner");
  const resultOverlay = document.getElementById("pong-result");
  const resultTitle = document.getElementById("pong-result-title");
  const resultBody = document.getElementById("pong-result-body");

  let youAreSeat = 0;
  let mirror = false; // true when we're seat 1, so we always see our own paddle on the left
  let currentDir = 0;

  function showScreen(name) {
    for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  }

  function toCanvasX(x) {
    return (mirror ? COURT_WIDTH - x : x) * (canvas.width / COURT_WIDTH);
  }
  function toCanvasY(y) {
    return y * (canvas.height / COURT_HEIGHT);
  }

  function render(state) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    const scaleX = canvas.width / COURT_WIDTH;
    const scaleY = canvas.height / COURT_HEIGHT;
    const paddleW = PADDLE_WIDTH * scaleX;
    const paddleH = PADDLE_HEIGHT * scaleY;

    state.paddles.forEach((paddle, seat) => {
      const px = seat === 0 ? 0 : COURT_WIDTH - PADDLE_WIDTH;
      // toCanvasX() mirrors the x coordinate but the paddle's own width
      // still needs to extend toward court-center from that mirrored edge.
      const drawX = mirror ? toCanvasX(px) - paddleW : toCanvasX(px);
      ctx.fillStyle = seat === youAreSeat ? "#c084fc" : "#e5e5e5";
      ctx.fillRect(drawX, toCanvasY(paddle.y) - paddleH / 2, paddleW, paddleH);
    });

    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(toCanvasX(state.ball.x), toCanvasY(state.ball.y), BALL_RADIUS * scaleX, 0, Math.PI * 2);
    ctx.fill();

    const myScore = state.scores[youAreSeat];
    const oppScore = state.scores[youAreSeat === 0 ? 1 : 0];
    scoreEl.textContent = myScore + " : " + oppScore + " (" + TARGET_SCORE + ")";
  }

  function setDir(dir) {
    if (dir === currentDir) return;
    currentDir = dir;
    // From the player's own point of view "up" is always up; when mirrored
    // (we're seat 1, court flipped horizontally for display) up/down don't
    // need flipping - only x is mirrored - so intent maps straight through.
    client.send("input", { input: { dir } });
  }

  const KEY_UP = new Set(["ArrowUp", "KeyW"]);
  const KEY_DOWN = new Set(["ArrowDown", "KeyS"]);
  const heldKeys = new Set();

  function recomputeDir() {
    let dir = 0;
    for (const k of heldKeys) {
      if (KEY_UP.has(k)) dir = -1;
      else if (KEY_DOWN.has(k)) dir = 1;
    }
    setDir(dir);
  }

  window.addEventListener("keydown", (event) => {
    if (!KEY_UP.has(event.code) && !KEY_DOWN.has(event.code)) return;
    if (screens.game.hidden) return;
    event.preventDefault();
    heldKeys.add(event.code);
    recomputeDir();
  });
  window.addEventListener("keyup", (event) => {
    heldKeys.delete(event.code);
    recomputeDir();
  });

  client.on("matched", (msg) => {
    youAreSeat = msg.youAreSeat;
    mirror = youAreSeat === 1;
    currentDir = 0;
    showScreen("game");
    resultOverlay.hidden = true;
    opponentBanner.hidden = true;
  });

  client.on("tick", (msg) => render(msg.state));
  client.on("state", (msg) => render(msg.state));

  client.on("gameOver", (msg) => {
    const won = msg.result === "decided" && msg.winnerSeat === youAreSeat;
    resultTitle.textContent = won ? resultTitle.dataset.win : resultTitle.dataset.lose;
    resultBody.textContent =
      typeof msg.ratingDelta === "number"
        ? resultBody.dataset.ratingTpl.replace("{{delta}}", (msg.ratingDelta >= 0 ? "+" : "") + msg.ratingDelta)
        : "";
    resultOverlay.hidden = false;
    heldKeys.clear();
    currentDir = 0;
  });

  client.on("opponentDisconnected", () => {
    opponentBanner.hidden = false;
  });
  client.on("opponentReconnected", () => {
    opponentBanner.hidden = true;
  });
  client.on("error", (msg) => console.error("[pong] server error:", msg.error));

  document.getElementById("pong-queue-button")?.addEventListener("click", () => {
    showScreen("queued");
    client.send("queue");
  });
  document.getElementById("pong-cancel-queue")?.addEventListener("click", () => {
    client.send("cancelQueue");
    showScreen("idle");
  });
  document.getElementById("pong-resign")?.addEventListener("click", () => {
    client.send("resign");
  });
  document.getElementById("pong-play-again")?.addEventListener("click", () => {
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
