// /games/pipe-dodger - a fully client-side flappy-style game built around the
// commissioned bird/pipe sprites (public/img/games/pipe-dodger/). No server
// state beyond the best score behind the leaderboard (db/gameScoresRepo.js,
// web-only database) - same shape as public/js/games/falling-blocks.js, whose
// leaderboard/leave-confirm/beforeunload wiring is copied here almost verbatim
// so both games behave the same way from the visitor's side.
(function () {
  "use strict";

  const board = document.getElementById("pd-board");
  const engine = window.PipeDodgerEngine;
  if (!board || !engine) return;

  // Physics, the hitbox and the difficulty ramp all live in the engine now, so
  // the server can re-simulate a run through the exact same code
  // (lib/gameReplay/pipe-dodger.js). Only the sizes the renderer needs are
  // pulled back out here.
  const WIDTH = engine.WIDTH;
  const HEIGHT = engine.HEIGHT;
  const GROUND_H = engine.GROUND_H;
  const BIRD_X = engine.BIRD_X;
  const BIRD_W = engine.BIRD_W;
  const BIRD_H = engine.BIRD_H;
  const PIPE_W = engine.PIPE_W;
  const BEST_KEY = "pipeDodgerBest";

  // Anti-cheat: flaps are recorded and the run is re-simulated server-side.
  // Bump RULES_VERSION here AND in lib/gameReplay/pipe-dodger.js together
  // whenever a physics constant changes - a mismatch makes the server skip
  // verification rather than mis-score an honest run.
  const RULES_VERSION = 1;
  const OP_FLAP = 0;

  const run = window.SoloRun.create({
    gameKey: "pipe-dodger",
    rulesVersion: RULES_VERSION,
    rootId: "pd-leaderboard",
    listId: "pd-lb-list",
    meWrapId: "pd-lb-me",
    meRowId: "pd-lb-me-row",
    // Flaps are timestamped in SIMULATION time, not wall time - see simTime
    // below - so the recorded clock matches what the server replays.
    now: () => simTime,
  });

  const ctx = board.getContext("2d");

  const scoreEl = document.getElementById("pd-score");
  const bestEl = document.getElementById("pd-best");

  const overlay = document.getElementById("pd-overlay");
  const overlayTitle = document.getElementById("pd-overlay-title");
  const overlayScore = document.getElementById("pd-overlay-score");
  const overlayButton = document.getElementById("pd-overlay-button");
  const overlayHint = document.getElementById("pd-overlay-hint");

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

  // --- Sprites ---------------------------------------------------------------

  const SPRITE_BASE = "/img/games/pipe-dodger/";
  const birdImg = new Image();
  birdImg.src = SPRITE_BASE + "bird.png";
  const pipeImg = new Image();
  pipeImg.src = SPRITE_BASE + "pipe.png";

  // Pipe sprite is a rim/cap (wide) sitting on a narrower repeatable body -
  // measured once against the source PNG (184x270). Slicing it this way lets
  // any pipe length stretch just the body, so the rim never distorts.
  const PIPE_SRC_W = 182;
  const PIPE_SRC_H = 268;
  const PIPE_CAP_SRC_H = 112;
  const PIPE_BODY_SRC_Y = 112;
  const PIPE_BODY_SRC_H = PIPE_SRC_H - PIPE_CAP_SRC_H;
  const PIPE_CAP_H = PIPE_CAP_SRC_H * (PIPE_W / PIPE_SRC_W);

  // --- Sound -------------------------------------------------------------

  const SOUND_BASE = "/sounds/games/pipe-dodger/";
  const SOUNDS = {
    flap: new Audio(SOUND_BASE + "flap.wav"),
    point: new Audio(SOUND_BASE + "point.wav"),
    hit: new Audio(SOUND_BASE + "hit.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

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

  // --- Game state ----------------------------------------------------------

  // The authoritative simulation. birdY/pipes/score below are read straight
  // off it by the renderer; nothing outside the engine may change them.
  let gs = null;
  let birdAngle = 0;
  // Simulation clock, in ms, advanced only in whole engine steps. Deliberately
  // NOT wall time: a frame is clamped (see stepAccumulator) so a backgrounded
  // tab can't come back to a dead bird, which means simulated time falls
  // behind real time. Flap timestamps are recorded against THIS clock, so the
  // server's replay lines up exactly.
  let simTime = 0;
  let stepAcc = 0;
  let pendingFlap = false;
  let score, best;
  let state = "idle"; // idle | running | paused | over
  // Guards start() against re-entry: the overlay button stays clickable
  // across its `await run.begin()`, and a fast-death game like this one
  // makes an impatient repeat click routine - without this, a second click
  // starts a second render loop racing the first.
  let starting = false;
  let rafId = null;
  let lastTime = 0;
  let particles = [];
  let shake = 0;
  let groundScroll = 0;
  let clouds = [];

  function reset() {
    // run.rng is the server's seeded stream while the run is ranked, plain
    // Math.random otherwise. Pipe gap positions are the only gameplay
    // randomness, and they must come from it - a bare Math.random() would
    // desync the server's replay immediately.
    gs = engine.createState(run.rng);
    birdAngle = 0;
    simTime = 0;
    stepAcc = 0;
    pendingFlap = false;
    score = 0;
    particles = [];
    shake = 0;
    groundScroll = 0;
    // Clouds are pure decoration and never touch the simulation, so they keep
    // their own unseeded randomness.
    clouds = Array.from({ length: 5 }, () => ({
      x: Math.random() * WIDTH,
      y: 30 + Math.random() * 160,
      r: 18 + Math.random() * 22,
      speed: 12 + Math.random() * 10,
    }));
    updateHud();
  }

  function flap() {
    if (state !== "running") return;
    // Queued rather than applied immediately: the flap takes effect at the
    // next fixed step, which is exactly when the server's replay applies it.
    pendingFlap = true;
    run.record(OP_FLAP);
    playSound("flap");
  }

  function spawnBirdBurst() {
    for (let i = 0; i < 18; i++) {
      const angle = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x: BIRD_X,
        y: gs.birdY,
        vx: Math.cos(angle) * sp,
        vy: Math.sin(angle) * sp - 1,
        color: ["#38bdf8", "#0f7ea8", "#ffffff", "#fb923c"][i % 4],
        size: 2 + Math.random() * 3,
        life: 0,
        maxLife: 450 + Math.random() * 300,
      });
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
      p.vy += 0.18 * dt;
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
      ctx.arc(p.x, p.y, Math.max(0.5, p.size * (1 - t * 0.3)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function gameOver() {
    state = "over";
    stopLoop();
    playSound("hit");
    spawnBirdBurst();
    shake = 1;
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
    dialogId: "pd-leave-confirm-dialog",
    saveId: "pd-leave-save",
    discardId: "pd-leave-discard",
    cancelId: "pd-leave-cancel",
    isInProgress: gameInProgress,
    canSave: () => run.canSubmit(),
    onSave: () => run.leaveBeacon(score),
  });

  function updateHud() {
    scoreEl.textContent = score;
    bestEl.textContent = best;
  }

  // --- Rendering -------------------------------------------------------------

  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT - GROUND_H);
    grad.addColorStop(0, "#1e1b4b");
    grad.addColorStop(0.6, "#312a5e");
    grad.addColorStop(1, "#3b2f63");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT - GROUND_H);

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (const c of clouds) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.r, c.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawGround() {
    const y = HEIGHT - GROUND_H;
    ctx.fillStyle = "#4c3a2a";
    ctx.fillRect(0, y, WIDTH, GROUND_H);
    ctx.fillStyle = "#5f4a35";
    ctx.fillRect(0, y, WIDTH, 10);

    // Scrolling stripe pattern for a sense of motion.
    const tile = 26;
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    const offset = ((groundScroll % tile) + tile) % tile;
    for (let x = -tile + offset; x < WIDTH + tile; x += tile) {
      ctx.beginPath();
      ctx.moveTo(x, y + 10);
      ctx.lineTo(x + 12, y + 10);
      ctx.lineTo(x + 4, HEIGHT);
      ctx.lineTo(x - 8, HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawPipeSegment(x, capAtBottom, topY, height) {
    if (!pipeImg.complete || !pipeImg.naturalWidth) return;
    const capH = Math.min(PIPE_CAP_H, height);
    const bodyH = Math.max(0, height - capH);
    if (!capAtBottom) {
      if (bodyH > 0) {
        ctx.drawImage(pipeImg, 0, PIPE_BODY_SRC_Y, PIPE_SRC_W, PIPE_BODY_SRC_H, x, topY + capH, PIPE_W, bodyH);
      }
      ctx.drawImage(pipeImg, 0, 0, PIPE_SRC_W, PIPE_CAP_SRC_H, x, topY, PIPE_W, capH);
    } else {
      if (bodyH > 0) {
        ctx.drawImage(pipeImg, 0, PIPE_BODY_SRC_Y, PIPE_SRC_W, PIPE_BODY_SRC_H, x, topY, PIPE_W, bodyH);
      }
      ctx.save();
      ctx.translate(x, topY + bodyH + capH);
      ctx.scale(1, -1);
      ctx.drawImage(pipeImg, 0, 0, PIPE_SRC_W, PIPE_CAP_SRC_H, 0, 0, PIPE_W, capH);
      ctx.restore();
    }
  }

  function drawPipes() {
    for (const pipe of gs.pipes) {
      drawPipeSegment(pipe.x, true, 0, pipe.gapTop);
      drawPipeSegment(pipe.x, false, pipe.gapBottom, HEIGHT - GROUND_H - pipe.gapBottom);
    }
  }

  function drawBird() {
    ctx.save();
    ctx.translate(BIRD_X, gs.birdY);
    ctx.rotate(birdAngle);
    if (birdImg.complete && birdImg.naturalWidth) {
      ctx.drawImage(birdImg, -BIRD_W / 2, -BIRD_H / 2, BIRD_W, BIRD_H);
    } else {
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.arc(0, 0, BIRD_W / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function draw() {
    ctx.save();
    if (shake > 0.01) {
      ctx.translate((Math.random() - 0.5) * 8 * shake, (Math.random() - 0.5) * 8 * shake);
    }
    drawSky();
    drawPipes();
    if (state !== "idle") drawBird();
    drawParticles();
    drawGround();
    ctx.restore();
  }

  // --- Loop ------------------------------------------------------------------

  function update(delta) {
    const dtS = delta / 1000;

    // --- Simulation: whole fixed steps only -------------------------------
    // The server advances the identical loop, so the two stay bit-for-bit in
    // step. A flap queued between frames is applied before the next step,
    // which is exactly where the replay applies it.
    if (pendingFlap) {
      engine.applyInput(gs, "flap");
      pendingFlap = false;
    }
    stepAcc += delta;
    while (stepAcc >= engine.FIXED_DT_MS && !gs.dead) {
      const result = engine.step(gs);
      stepAcc -= engine.FIXED_DT_MS;
      simTime += engine.FIXED_DT_MS;
      for (let i = 0; i < result.scored; i++) {
        score = gs.score;
        playSound("point", { rate: 1 + Math.min(0.3, score / 100) });
        updateHud();
      }
    }
    score = gs.score;

    // --- Presentation: free-running, never feeds back into the simulation --
    for (const c of clouds) {
      c.x -= c.speed * dtS;
      if (c.x < -c.r * 2) {
        c.x = WIDTH + c.r * 2;
        c.y = 30 + Math.random() * 160;
      }
    }
    groundScroll -= gs.speed * dtS;
    const targetAngle = Math.max(-0.5, Math.min(1.3, gs.birdVy / 700));
    birdAngle += (targetAngle - birdAngle) * Math.min(1, dtS * 10);

    updateParticles(delta);
    if (shake > 0) shake = Math.max(0, shake - dtS * 2.5);

    if (gs.dead) gameOver();
  }

  function loop(time) {
    rafId = requestAnimationFrame(loop);
    const delta = Math.min(48, time - lastTime);
    lastTime = time;
    if (state === "running") update(delta);
    else updateParticles(delta);
    draw();
  }

  function startLoop() {
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // --- Overlay / state transitions ------------------------------------------

  function showOverlay(kind) {
    const d = overlay.dataset;
    overlayScore.hidden = kind !== "over";
    overlayHint.textContent = kind === "start" ? d.tapHint : "";
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
    overlay.style.display = "";
  }

  function hideOverlay() {
    overlay.style.display = "none";
  }

  async function start() {
    if (starting) return;
    starting = true;
    try {
      // Zero the simulation clock BEFORE minting the run, not in reset()
      // below: begin() builds the recorder, which captures its time origin by
      // reading this very clock (handed to it as `now: () => simTime`). Left
      // to reset(), the origin on every run after the first was the PREVIOUS
      // run's final simTime - a clock origin in the future, which clamps the
      // first event's dt to 0 and floors the encoded run duration to 0. See
      // the same fix in falling-blocks.js for the flags it produced.
      simTime = 0;
      stepAcc = 0;
      // Register the run before reset() deals the first pipes - it needs the
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

  // Auto-pause when the tab loses focus - an unwatched game shouldn't end itself.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("blur", pause);

  // --- Input -----------------------------------------------------------------

  document.addEventListener("keydown", (event) => {
    if (event.code === "KeyP" && (state === "running" || state === "paused")) {
      event.preventDefault();
      if (state === "running") pause();
      else resume();
      return;
    }
    if (state !== "running") return;
    if (event.code === "Space" || event.key === "ArrowUp" || event.code === "KeyW") {
      event.preventDefault();
      flap();
    }
  });

  board.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    flap();
  });

  // --- Boot ------------------------------------------------------------------

  best = readBest();
  reset();
  draw();
  showOverlay("start");
})();
