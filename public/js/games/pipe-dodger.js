// /games/pipe-dodger - a fully client-side flappy-style game built around the
// commissioned bird/pipe sprites (public/img/games/pipe-dodger/). No server
// state beyond the best score behind the leaderboard (db/gameScoresRepo.js,
// web-only database) - same shape as public/js/games/falling-blocks.js, whose
// leaderboard/leave-confirm/beforeunload wiring is copied here almost verbatim
// so both games behave the same way from the visitor's side.
(function () {
  "use strict";

  const board = document.getElementById("pd-board");
  if (!board) return;

  const WIDTH = 360;
  const HEIGHT = 600;
  const GROUND_H = 70;
  const BEST_KEY = "pipeDodgerBest";

  const BIRD_X = 110;
  const BIRD_W = 44;
  const BIRD_H = 40;
  // Hitbox smaller than the sprite so near-miss grazes feel fair.
  const BIRD_HIT_INSET_X = 7;
  const BIRD_HIT_INSET_Y = 6;

  const GRAVITY = 1500; // px/s^2
  const FLAP_VELOCITY = -420; // px/s
  const MAX_FALL_SPEED = 640; // px/s

  const PIPE_W = 58;
  const GAP_START = 168;
  const GAP_MIN = 128;
  const SPEED_START = 150; // px/s
  const SPEED_MAX = 260;
  const SPAWN_SPACING = 235; // px between pipe pairs, at current speed
  // Difficulty ramps continuously with score until the _MIN/_MAX bounds above.
  const RAMP_POINTS_TO_MAX = 15; // reach max difficulty by this score

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
      node.volume = opts && opts.volume != null ? opts.volume : base.volume;
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

  let birdY, birdVy, birdAngle;
  let pipes, distSinceSpawn, speed, gap;
  let score, best;
  let state = "idle"; // idle | running | paused | over
  let rafId = null;
  let lastTime = 0;
  let particles = [];
  let shake = 0;
  let groundScroll = 0;
  let clouds = [];

  function difficultyFor(currentScore) {
    const t = Math.min(1, currentScore / RAMP_POINTS_TO_MAX);
    return {
      speed: SPEED_START + (SPEED_MAX - SPEED_START) * t,
      gap: GAP_START - (GAP_START - GAP_MIN) * t,
    };
  }

  function reset() {
    birdY = HEIGHT / 2;
    birdVy = 0;
    birdAngle = 0;
    pipes = [];
    distSinceSpawn = 0;
    score = 0;
    particles = [];
    shake = 0;
    groundScroll = 0;
    const d = difficultyFor(0);
    speed = d.speed;
    gap = d.gap;
    clouds = Array.from({ length: 5 }, () => ({
      x: Math.random() * WIDTH,
      y: 30 + Math.random() * 160,
      r: 18 + Math.random() * 22,
      speed: 12 + Math.random() * 10,
    }));
    updateHud();
  }

  function spawnPipe() {
    const margin = 40;
    const usableH = HEIGHT - GROUND_H - margin * 2 - gap;
    const gapTop = margin + Math.random() * Math.max(0, usableH);
    pipes.push({ x: WIDTH, gapTop, gapBottom: gapTop + gap, passed: false });
  }

  function flap() {
    if (state !== "running") return;
    birdVy = FLAP_VELOCITY;
    playSound("flap");
  }

  function birdHitbox() {
    return {
      left: BIRD_X - BIRD_W / 2 + BIRD_HIT_INSET_X,
      right: BIRD_X + BIRD_W / 2 - BIRD_HIT_INSET_X,
      top: birdY - BIRD_H / 2 + BIRD_HIT_INSET_Y,
      bottom: birdY + BIRD_H / 2 - BIRD_HIT_INSET_Y,
    };
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function checkCollision() {
    const hb = birdHitbox();
    if (hb.top <= 0 || hb.bottom >= HEIGHT - GROUND_H) return true;
    for (const pipe of pipes) {
      if (pipe.x + PIPE_W < hb.left || pipe.x > hb.right) continue;
      const top = { left: pipe.x, right: pipe.x + PIPE_W, top: 0, bottom: pipe.gapTop };
      const bottom = { left: pipe.x, right: pipe.x + PIPE_W, top: pipe.gapBottom, bottom: HEIGHT - GROUND_H };
      if (rectsOverlap(hb, top) || rectsOverlap(hb, bottom)) return true;
    }
    return false;
  }

  function spawnBirdBurst() {
    for (let i = 0; i < 18; i++) {
      const angle = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x: BIRD_X,
        y: birdY,
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
    submitScore(score);
    showOverlay("over");
  }

  // --- Leaderboard -----------------------------------------------------------
  // Identical wiring to public/js/games/falling-blocks.js's leaderboard section -
  // keep both in sync if the shared markup/response shape ever changes.

  const leaderboard = document.getElementById("pd-leaderboard");
  const lbList = document.getElementById("pd-lb-list");
  const lbMeWrap = document.getElementById("pd-lb-me");
  const lbMeRow = document.getElementById("pd-lb-me-row");

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

  // --- Leave-page confirmation ----------------------------------------------

  function gameInProgress() {
    return state === "running" || state === "paused";
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

  const leaveDialog = document.getElementById("pd-leave-confirm-dialog");
  const leaveSaveBtn = document.getElementById("pd-leave-save");
  const leaveDiscardBtn = document.getElementById("pd-leave-discard");
  const leaveCancelBtn = document.getElementById("pd-leave-cancel");
  let pendingLeaveHref = null;

  if (leaveDialog) {
    document.addEventListener("click", (event) => {
      if (!gameInProgress()) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest("a[href]");
      if (!link || link.target === "_blank") return;
      event.preventDefault();
      pendingLeaveHref = link.href;
      pause();
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
    for (const pipe of pipes) {
      drawPipeSegment(pipe.x, true, 0, pipe.gapTop);
      drawPipeSegment(pipe.x, false, pipe.gapBottom, HEIGHT - GROUND_H - pipe.gapBottom);
    }
  }

  function drawBird() {
    ctx.save();
    ctx.translate(BIRD_X, birdY);
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
    const d = difficultyFor(score);
    speed = d.speed;
    gap = d.gap;

    for (const c of clouds) {
      c.x -= c.speed * dtS;
      if (c.x < -c.r * 2) {
        c.x = WIDTH + c.r * 2;
        c.y = 30 + Math.random() * 160;
      }
    }
    groundScroll -= speed * dtS;

    birdVy = Math.min(MAX_FALL_SPEED, birdVy + GRAVITY * dtS);
    birdY += birdVy * dtS;
    const targetAngle = Math.max(-0.5, Math.min(1.3, birdVy / 700));
    birdAngle += (targetAngle - birdAngle) * Math.min(1, dtS * 10);

    distSinceSpawn += speed * dtS;
    if (distSinceSpawn >= SPAWN_SPACING) {
      distSinceSpawn -= SPAWN_SPACING;
      spawnPipe();
    }

    for (const pipe of pipes) {
      pipe.x -= speed * dtS;
      if (!pipe.passed && pipe.x + PIPE_W < BIRD_X - BIRD_W / 2) {
        pipe.passed = true;
        score++;
        playSound("point", { rate: 1 + Math.min(0.3, score / 100) });
        updateHud();
      }
    }
    pipes = pipes.filter((pipe) => pipe.x > -PIPE_W - 5);

    updateParticles(delta);
    if (shake > 0) shake = Math.max(0, shake - dtS * 2.5);

    if (checkCollision()) {
      gameOver();
    }
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
