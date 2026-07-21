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
  const PADDLE_SPEED = 300; // units/sec - only used for local extrapolation
  const BALL_RADIUS = 6;
  const TARGET_SCORE = 7;

  // Client-side smoothing. The server stays fully authoritative, but it only
  // ticks ~30/s, so drawing one frame per "tick" push moved everything in
  // 33ms steps at whatever jitter the network delivered them with - the ball
  // visibly teleported. Instead every push is treated as a *snapshot*, and a
  // requestAnimationFrame loop renders continuously by (a) extrapolating that
  // snapshot forward by the time since it arrived - the state already carries
  // the ball's vx/vy and each paddle's dir, so this is the same integration
  // the server's step() does - and (b) easing the drawn position toward that
  // target, so a mispredicted bounce is corrected over ~60ms instead of
  // jumping. Deliberately extrapolation rather than the classic buffered
  // snapshot interpolation (render ~100ms in the past): Pong is a reaction
  // game and that buffer would add its delay to your own paddle too.
  const SMOOTH_TAU_MS = 60; // error half-life; lower = snappier, higher = smoother
  const SNAP_DISTANCE = 40; // units - beyond this it's a real jump (new point), snap
  const MAX_EXTRAPOLATE_MS = 250; // don't keep dead-reckoning through a stalled tick

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

  let snapshot = null; // last authoritative state pushed by the server
  let snapshotAt = 0; // performance.now() when it arrived
  let view = null; // { ballX, ballY, paddleY: [y0, y1] } - what's actually drawn
  let error = { ballX: 0, ballY: 0, paddleY: [0, 0] }; // last correction, decaying to zero
  let rafHandle = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function showScreen(name) {
    for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  }

  function toCanvasX(x) {
    return (mirror ? COURT_WIDTH - x : x) * (canvas.width / COURT_WIDTH);
  }
  function toCanvasY(y) {
    return y * (canvas.height / COURT_HEIGHT);
  }

  // Where the snapshot says everything *should* be right now, `ms` after it
  // was captured.
  function extrapolate(ms) {
    const dt = Math.min(Math.max(ms, 0), MAX_EXTRAPOLATE_MS) / 1000;
    const ball = snapshot.ball;
    let y = ball.y + ball.vy * dt;
    // Fold the path back off the top/bottom walls the way step() does, so a
    // bounce landing between two snapshots doesn't send the ball off-court.
    const span = COURT_HEIGHT - 2 * BALL_RADIUS;
    if (span > 0) {
      let rel = (y - BALL_RADIUS) % (2 * span);
      if (rel < 0) rel += 2 * span;
      y = BALL_RADIUS + (rel > span ? 2 * span - rel : rel);
    }
    return {
      ballX: clamp(ball.x + ball.vx * dt, -BALL_RADIUS, COURT_WIDTH + BALL_RADIUS),
      ballY: y,
      paddleY: snapshot.paddles.map((paddle, seat) => {
        // For our own paddle we integrate the key held *right now* instead of
        // the direction the last snapshot knew about - that's the bit that
        // makes our own paddle feel free of input lag. The server still owns
        // the real position; any drift is eased away below.
        const dir = seat === youAreSeat ? currentDir : paddle.dir;
        return clamp(paddle.y + dir * PADDLE_SPEED * dt, PADDLE_HEIGHT / 2, COURT_HEIGHT - PADDLE_HEIGHT / 2);
      }),
    };
  }

  // Correction is applied as a *decaying error offset* on top of the
  // extrapolated position, not by easing the drawn position toward it:
  // easing toward a target that itself moves every frame leaves the ball
  // permanently trailing by roughly one time-constant (~12 units here), which
  // is exactly the sluggishness this is meant to remove. An error that decays
  // to zero hides the correction just as well and costs no steady-state lag.
  function decayedError(ageMs) {
    return Math.exp(-ageMs / SMOOTH_TAU_MS);
  }

  // Beyond SNAP_DISTANCE it isn't a misprediction, it's a real jump (a scored
  // point recentres the ball and both paddles) - carry no error, just snap.
  function offsetFor(previous, fresh) {
    const delta = previous - fresh;
    return Math.abs(delta) > SNAP_DISTANCE ? 0 : delta;
  }

  function frame(now) {
    rafHandle = requestAnimationFrame(frame);
    if (!snapshot) return;
    const target = extrapolate(now - snapshotAt);
    const decay = decayedError(now - snapshotAt);
    view = {
      ballX: target.ballX + error.ballX * decay,
      ballY: target.ballY + error.ballY * decay,
      paddleY: target.paddleY.map((y, seat) => y + error.paddleY[seat] * decay),
    };
    render(snapshot, view);
  }

  function startLoop() {
    if (rafHandle == null) rafHandle = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  // Every server push lands here. The offset between what we were already
  // drawing and where this snapshot says things are becomes the error to
  // decay away, so the picture never jumps at the seam between snapshots.
  function applySnapshot(state) {
    const drawn = view;
    snapshot = state;
    snapshotAt = performance.now();
    const fresh = extrapolate(0);
    if (!drawn) {
      error = { ballX: 0, ballY: 0, paddleY: fresh.paddleY.map(() => 0) };
    } else {
      error = {
        ballX: offsetFor(drawn.ballX, fresh.ballX),
        ballY: offsetFor(drawn.ballY, fresh.ballY),
        paddleY: fresh.paddleY.map((y, seat) => offsetFor(drawn.paddleY[seat], y)),
      };
    }
    startLoop();
  }

  function render(state, drawn) {
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

    state.paddles.forEach((_paddle, seat) => {
      const px = seat === 0 ? 0 : COURT_WIDTH - PADDLE_WIDTH;
      // toCanvasX() mirrors the x coordinate but the paddle's own width
      // still needs to extend toward court-center from that mirrored edge.
      const drawX = mirror ? toCanvasX(px) - paddleW : toCanvasX(px);
      ctx.fillStyle = seat === youAreSeat ? "#c084fc" : "#e5e5e5";
      ctx.fillRect(drawX, toCanvasY(drawn.paddleY[seat]) - paddleH / 2, paddleW, paddleH);
    });

    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(toCanvasX(drawn.ballX), toCanvasY(drawn.ballY), BALL_RADIUS * scaleX, 0, Math.PI * 2);
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
    snapshot = null;
    view = null;
    error = { ballX: 0, ballY: 0, paddleY: [0, 0] };
    showScreen("game");
    resultOverlay.hidden = true;
    opponentBanner.hidden = true;
  });

  client.on("tick", (msg) => applySnapshot(msg.state));
  client.on("state", (msg) => applySnapshot(msg.state));

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
    // Nothing moves after the final point - freeze on the last snapshot
    // rather than burning a rAF loop behind the result overlay.
    stopLoop();
    if (snapshot) render(snapshot, extrapolate(0));
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
