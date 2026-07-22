// /games/cloud-climber - a fully client-side endless-jumper (Doodle-Jump-style)
// game. No sprite/sound assets yet - every shape below is drawn with plain
// canvas primitives on purpose, same "ship the mechanics first" approach as
// falling-blocks' block rendering; textures + sound can be layered in later
// exactly like pipe-dodger's were, without touching the physics/collision
// code. No server state beyond the best score behind the leaderboard
// (db/gameScoresRepo.js, web-only database) - leaderboard/leave-confirm/
// beforeunload wiring is copied from public/js/games/pipe-dodger.js almost
// verbatim so both games behave the same way from the visitor's side.
(function () {
  "use strict";

  const board = document.getElementById("cc-board");
  if (!board) return;

  const WIDTH = 360;
  const HEIGHT = 600;
  const BEST_KEY = "cloudClimberBest";

  const PLAYER_W = 40;
  const PLAYER_H = 44;
  // Hitbox narrower than the drawn body so near-miss grazes off a platform's
  // edge still count as a landing - matches pipe-dodger's forgiving-hitbox approach.
  const PLAYER_HIT_HALF_W = PLAYER_W / 2 - 6;

  const GRAVITY = 1700; // px/s^2
  const MAX_FALL_SPEED = 900; // px/s
  const JUMP_VELOCITY = -680; // normal/moving/breaking platform bounce
  const BOUNCY_VELOCITY = -900; // always-bouncy platform
  const SPRING_VELOCITY = -1150; // spring pickup, the biggest plain bounce
  const JETPACK_SPEED = -620; // constant climb speed while a jetpack is active
  const JETPACK_DURATION_MS = 2200;

  const STEER_GAIN = 6; // how eagerly the player chases a drag/touch target
  const ACCEL = 2200; // px/s^2, keyboard control
  const FRICTION_DECEL = 2600; // px/s^2, keyboard control with no key held
  const MAX_H_SPEED = 380; // px/s

  const PLATFORM_W = 68;
  const PLATFORM_H = 16;
  const MIN_GAP = 70;
  const MAX_GAP = 122; // stays reachable by a plain JUMP_VELOCITY bounce (max ~136px)
  const RAMP_WORLD_DISTANCE = 4000; // px of climb to reach max difficulty
  const SCROLL_THRESHOLD = HEIGHT * 0.42;
  const BREAK_FADE_MS = 320;
  const MOVING_SPEED_MIN = 55;
  const MOVING_SPEED_MAX = 130;

  const SPRING_CHANCE = 0.07;
  const JETPACK_CHANCE = 0.018;

  const ctx = board.getContext("2d");
  const hasRoundRect = typeof ctx.roundRect === "function";
  function roundRectPath(context, x, y, w, h, r) {
    if (hasRoundRect) context.roundRect(x, y, w, h, r);
    else context.rect(x, y, w, h);
  }

  const scoreEl = document.getElementById("cc-score");
  const bestEl = document.getElementById("cc-best");

  const overlay = document.getElementById("cc-overlay");
  const overlayTitle = document.getElementById("cc-overlay-title");
  const overlayScore = document.getElementById("cc-overlay-score");
  const overlayButton = document.getElementById("cc-overlay-button");
  const overlayHint = document.getElementById("cc-overlay-hint");

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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // --- Game state ------------------------------------------------------------

  let player; // {x, y, vx, vy}
  let camera; // {y} - screenY = worldY - camera.y; camera.y only ever decreases
  let platforms;
  let highestGeneratedY;
  let jetpack; // {active, timeLeft}
  let score, best;
  let state = "idle"; // idle | running | paused | over
  let rafId = null;
  let lastTime = 0;
  let particles = [];
  let clouds = [];
  let leftHeld = false;
  let rightHeld = false;
  let steerActive = false;
  let steerTargetX = WIDTH / 2;

  function difficultyAt(worldClimb) {
    return Math.min(1, worldClimb / RAMP_WORLD_DISTANCE);
  }

  function weightedPick(entries) {
    const total = entries.reduce((sum, e) => sum + e.weight, 0);
    let r = Math.random() * total;
    for (const e of entries) {
      if (r < e.weight) return e.type;
      r -= e.weight;
    }
    return entries[entries.length - 1].type;
  }

  function pickPlatformType(t) {
    return weightedPick([
      { type: "normal", weight: 0.75 - 0.4 * t },
      { type: "moving", weight: 0.15 + 0.15 * t },
      { type: "breaking", weight: 0.1 + 0.15 * t },
      { type: "bouncy", weight: 0.1 },
    ]);
  }

  function spawnPlatformAt(y, t) {
    const type = pickPlatformType(t);
    const margin = PLATFORM_W / 2 + 6;
    const x = margin + Math.random() * (WIDTH - margin * 2);
    const platform = {
      x,
      y,
      w: PLATFORM_W,
      h: PLATFORM_H,
      type,
      alive: true,
      collidable: true,
      breaking: false,
      breakTimer: 0,
      alpha: 1,
      item: null,
    };
    if (type === "moving") {
      const speed = MOVING_SPEED_MIN + Math.random() * (MOVING_SPEED_MAX - MOVING_SPEED_MIN) * t;
      platform.vx = Math.random() < 0.5 ? -speed : speed;
    }
    // Breaking platforms are about to vanish, so a boost placed on one would
    // usually be wasted or double-trigger alongside the break - keep boosts
    // off them for a clean, predictable pickup.
    if (type !== "breaking") {
      const roll = Math.random();
      if (roll < JETPACK_CHANCE) platform.item = { type: "jetpack" };
      else if (roll < JETPACK_CHANCE + SPRING_CHANCE) platform.item = { type: "spring" };
    }
    platforms.push(platform);
  }

  function ensurePlatformsAhead() {
    const targetTop = camera.y - 200;
    while (highestGeneratedY > targetTop) {
      const t = difficultyAt(-highestGeneratedY);
      const gap = MIN_GAP + (MAX_GAP - MIN_GAP) * t + (Math.random() * 20 - 10);
      highestGeneratedY -= gap;
      spawnPlatformAt(highestGeneratedY, t);
    }
  }

  function reset() {
    player = { x: WIDTH / 2, y: HEIGHT - 140, vx: 0, vy: JUMP_VELOCITY * 0.7 };
    camera = { y: 0 };
    jetpack = { active: false, timeLeft: 0 };
    platforms = [];
    score = 0;
    particles = [];
    leftHeld = false;
    rightHeld = false;
    steerActive = false;

    // A guaranteed wide starting platform right under the player.
    highestGeneratedY = HEIGHT - 60;
    platforms.push({
      x: WIDTH / 2,
      y: highestGeneratedY,
      w: PLATFORM_W,
      h: PLATFORM_H,
      type: "normal",
      alive: true,
      collidable: true,
      breaking: false,
      breakTimer: 0,
      alpha: 1,
      item: null,
    });
    ensurePlatformsAhead();

    clouds = Array.from({ length: 6 }, () => ({
      x: Math.random() * WIDTH,
      y: Math.random() * HEIGHT,
      r: 16 + Math.random() * 20,
      depth: 0.3 + Math.random() * 0.5,
    }));

    updateHud();
  }

  function playerBox() {
    return {
      left: player.x - PLAYER_HIT_HALF_W,
      right: player.x + PLAYER_HIT_HALF_W,
      top: player.y - PLAYER_H / 2,
      bottom: player.y + PLAYER_H / 2,
    };
  }

  function spawnDeathBurst() {
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 3.5;
      particles.push({
        x: player.x,
        y: player.y - camera.y,
        vx: Math.cos(angle) * sp,
        vy: Math.sin(angle) * sp - 1,
        color: ["#22c55e", "#4ade80", "#ffffff", "#16a34a"][i % 4],
        size: 2 + Math.random() * 3,
        life: 0,
        maxLife: 450 + Math.random() * 300,
      });
    }
  }

  function spawnJetpackParticle() {
    particles.push({
      x: player.x + (Math.random() * 14 - 7),
      y: player.y - camera.y + PLAYER_H / 2 - 4,
      vx: Math.random() * 1.2 - 0.6,
      vy: 2 + Math.random() * 1.5,
      color: Math.random() < 0.5 ? "#fb923c" : "#fbbf24",
      size: 2 + Math.random() * 2.5,
      life: 0,
      maxLife: 220 + Math.random() * 120,
    });
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
    spawnDeathBurst();
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    submitScore(score);
    showOverlay("over");
  }

  // --- Leaderboard -----------------------------------------------------------
  // Identical wiring to public/js/games/pipe-dodger.js's leaderboard section -
  // keep both in sync if the shared markup/response shape ever changes.

  const leaderboard = document.getElementById("cc-leaderboard");
  const lbList = document.getElementById("cc-lb-list");
  const lbMeWrap = document.getElementById("cc-lb-me");
  const lbMeRow = document.getElementById("cc-lb-me-row");

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

  // --- Leave-page confirmation ------------------------------------------------

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

  const leaveDialog = document.getElementById("cc-leave-confirm-dialog");
  const leaveSaveBtn = document.getElementById("cc-leave-save");
  const leaveDiscardBtn = document.getElementById("cc-leave-discard");
  const leaveCancelBtn = document.getElementById("cc-leave-cancel");
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

  // --- Rendering ---------------------------------------------------------------

  function drawSky() {
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    grad.addColorStop(0, "#7dd3fc");
    grad.addColorStop(1, "#bae6fd");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = "rgba(255,255,255,0.75)";
    for (const c of clouds) {
      const screenY = ((c.y - camera.y * c.depth) % (HEIGHT + 80) + HEIGHT + 80) % (HEIGHT + 80) - 40;
      ctx.beginPath();
      ctx.ellipse(c.x, screenY, c.r, c.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSpringIcon(x, y) {
    ctx.strokeStyle = "#a16207";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    const w = 5;
    for (let i = 0; i < 4; i++) {
      const sx = x - w * 1.5 + i * w;
      ctx.moveTo(sx, y + 6);
      ctx.lineTo(sx + w / 2, y - 6);
    }
    ctx.stroke();
  }

  function drawJetpackIcon(x, y) {
    ctx.fillStyle = "#78350f";
    ctx.beginPath();
    roundRectPath(ctx, x - 9, y - 10, 8, 16, 2);
    roundRectPath(ctx, x + 1, y - 10, 8, 16, 2);
    ctx.fill();
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 6);
    ctx.lineTo(x - 3, y + 13);
    ctx.lineTo(x, y + 6);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 4, y + 6);
    ctx.lineTo(x + 7, y + 13);
    ctx.lineTo(x + 10, y + 6);
    ctx.closePath();
    ctx.fill();
  }

  function platformColor(type) {
    switch (type) {
      case "moving":
        return { fill: "#38bdf8", edge: "#0284c7" };
      case "breaking":
        return { fill: "#d6b98c", edge: "#92703f" };
      case "bouncy":
        return { fill: "#fbbf24", edge: "#b45309" };
      default:
        return { fill: "#4ade80", edge: "#15803d" };
    }
  }

  function drawPlatforms() {
    for (const p of platforms) {
      const screenY = p.y - camera.y;
      if (screenY < -30 || screenY > HEIGHT + 30) continue;
      const colors = platformColor(p.type);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = colors.fill;
      ctx.beginPath();
      roundRectPath(ctx, p.x - p.w / 2, screenY - p.h / 2, p.w, p.h, 6);
      ctx.fill();
      ctx.fillStyle = colors.edge;
      ctx.fillRect(p.x - p.w / 2 + 3, screenY - p.h / 2 + p.h - 4, p.w - 6, 3);

      if (p.type === "bouncy") {
        drawSpringIcon(p.x, screenY - p.h / 2 - 2);
      }
      if (p.type === "breaking") {
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - p.w / 4, screenY - p.h / 2 + 2);
        ctx.lineTo(p.x - p.w / 8, screenY + p.h / 2 - 2);
        ctx.moveTo(p.x + p.w / 6, screenY - p.h / 2 + 2);
        ctx.lineTo(p.x + p.w / 3, screenY + p.h / 2 - 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (p.item) {
        const itemY = screenY - p.h / 2 - 12;
        if (p.item.type === "spring") drawSpringIcon(p.x, itemY);
        else if (p.item.type === "jetpack") drawJetpackIcon(p.x, itemY);
      }
    }
  }

  function drawPlayer() {
    const screenY = player.y - camera.y;
    const speedFactor = clamp(Math.abs(player.vy) / 900, 0, 1);
    const stretch = player.vy < 0 ? 1 + speedFactor * 0.18 : 1 - speedFactor * 0.12;
    const squash = 1 / Math.sqrt(stretch);
    const lookDir = clamp(player.vx / MAX_H_SPEED, -1, 1);

    ctx.save();
    ctx.translate(player.x, screenY);
    ctx.scale(squash, stretch);

    ctx.fillStyle = jetpack.active ? "#16a34a" : "#22c55e";
    ctx.beginPath();
    ctx.ellipse(0, 0, PLAYER_W / 2, PLAYER_H / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs, tucked while rising and dangling while falling.
    const legSpread = player.vy < 0 ? 4 : 9;
    ctx.strokeStyle = "#15803d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-8, PLAYER_H / 2 - 4);
    ctx.lineTo(-8 - legSpread * 0.4, PLAYER_H / 2 + 8);
    ctx.moveTo(8, PLAYER_H / 2 - 4);
    ctx.lineTo(8 + legSpread * 0.4, PLAYER_H / 2 + 8);
    ctx.stroke();

    // Eyes, shifted slightly toward the direction of travel.
    const eyeOffsetX = 6 + lookDir * 3;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-eyeOffsetX, -6, 6, 0, Math.PI * 2);
    ctx.arc(eyeOffsetX, -6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#171717";
    ctx.beginPath();
    ctx.arc(-eyeOffsetX + lookDir * 2, -6, 2.6, 0, Math.PI * 2);
    ctx.arc(eyeOffsetX + lookDir * 2, -6, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  function draw() {
    drawSky();
    drawPlatforms();
    drawParticles();
    if (state !== "idle") drawPlayer();
  }

  // --- Update ------------------------------------------------------------------

  function updateHorizontal(dtS) {
    if (steerActive) {
      const desiredVx = clamp((steerTargetX - player.x) * STEER_GAIN, -MAX_H_SPEED, MAX_H_SPEED);
      player.vx += (desiredVx - player.vx) * Math.min(1, dtS * 12);
    } else if (leftHeld || rightHeld) {
      if (leftHeld) player.vx -= ACCEL * dtS;
      if (rightHeld) player.vx += ACCEL * dtS;
      player.vx = clamp(player.vx, -MAX_H_SPEED, MAX_H_SPEED);
    } else {
      const decel = FRICTION_DECEL * dtS;
      if (Math.abs(player.vx) <= decel) player.vx = 0;
      else player.vx -= Math.sign(player.vx) * decel;
    }
    player.x += player.vx * dtS;
    if (player.x < -PLAYER_W / 2) player.x = WIDTH + PLAYER_W / 2;
    else if (player.x > WIDTH + PLAYER_W / 2) player.x = -PLAYER_W / 2;
  }

  function tryLandOn(prevBottom, currentBottom) {
    for (const p of platforms) {
      if (!p.alive || !p.collidable) continue;
      const left = p.x - p.w / 2;
      const right = p.x + p.w / 2;
      if (player.x + PLAYER_HIT_HALF_W < left || player.x - PLAYER_HIT_HALF_W > right) continue;
      const topY = p.y - p.h / 2;
      if (prevBottom <= topY && currentBottom >= topY) {
        player.y = topY - PLAYER_H / 2;
        if (p.item && p.item.type === "spring") {
          player.vy = SPRING_VELOCITY;
          p.item = null;
        } else if (p.type === "bouncy") {
          player.vy = BOUNCY_VELOCITY;
        } else {
          player.vy = JUMP_VELOCITY;
        }
        if (p.type === "breaking") {
          p.collidable = false;
          p.breaking = true;
        }
        return;
      }
    }
  }

  function tryPickupJetpack() {
    if (jetpack.active) return;
    const box = playerBox();
    for (const p of platforms) {
      if (!p.alive || !p.item || p.item.type !== "jetpack") continue;
      const itemLeft = p.x - 10;
      const itemRight = p.x + 10;
      const itemTop = p.y - p.h / 2 - 22;
      const itemBottom = p.y - p.h / 2 - 2;
      if (box.left < itemRight && box.right > itemLeft && box.top < itemBottom && box.bottom > itemTop) {
        p.item = null;
        jetpack.active = true;
        jetpack.timeLeft = JETPACK_DURATION_MS;
        return;
      }
    }
  }

  function update(delta) {
    const dtS = delta / 1000;

    for (const c of clouds) {
      c.x -= 8 * c.depth * dtS;
      if (c.x < -c.r * 2) c.x = WIDTH + c.r * 2;
    }

    updateHorizontal(dtS);

    const prevBottom = player.y + PLAYER_H / 2;

    if (jetpack.active) {
      jetpack.timeLeft -= delta;
      player.vy = JETPACK_SPEED;
      spawnJetpackParticle();
      if (jetpack.timeLeft <= 0) {
        jetpack.active = false;
        player.vy = JUMP_VELOCITY * 0.6;
      }
    } else {
      player.vy = Math.min(MAX_FALL_SPEED, player.vy + GRAVITY * dtS);
    }
    player.y += player.vy * dtS;
    const currentBottom = player.y + PLAYER_H / 2;

    if (!jetpack.active && player.vy > 0) {
      tryLandOn(prevBottom, currentBottom);
    }
    tryPickupJetpack();

    for (const p of platforms) {
      if (p.type === "moving" && p.alive) {
        p.x += p.vx * dtS;
        if (p.x - p.w / 2 < 0) {
          p.x = p.w / 2;
          p.vx *= -1;
        } else if (p.x + p.w / 2 > WIDTH) {
          p.x = WIDTH - p.w / 2;
          p.vx *= -1;
        }
      }
      if (p.breaking) {
        p.breakTimer += delta;
        p.alpha = Math.max(0, 1 - p.breakTimer / BREAK_FADE_MS);
        if (p.breakTimer >= BREAK_FADE_MS) p.alive = false;
      }
    }

    const desiredCameraY = player.y - SCROLL_THRESHOLD;
    camera.y = Math.min(camera.y, desiredCameraY);

    score = Math.max(0, Math.floor(-camera.y / 10));

    ensurePlatformsAhead();
    platforms = platforms.filter((p) => p.alive && p.y - camera.y < HEIGHT + 60);

    updateParticles(delta);
    updateHud();

    if (player.y - camera.y > HEIGHT + PLAYER_H) {
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

  // --- Overlay / state transitions --------------------------------------------

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

  // --- Input -------------------------------------------------------------------

  document.addEventListener("keydown", (event) => {
    if (event.code === "KeyP" && (state === "running" || state === "paused")) {
      event.preventDefault();
      if (state === "running") pause();
      else resume();
      return;
    }
    if (event.code === "ArrowLeft" || event.code === "KeyA") {
      leftHeld = true;
      steerActive = false;
    } else if (event.code === "ArrowRight" || event.code === "KeyD") {
      rightHeld = true;
      steerActive = false;
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.code === "ArrowLeft" || event.code === "KeyA") leftHeld = false;
    else if (event.code === "ArrowRight" || event.code === "KeyD") rightHeld = false;
  });

  function pointerToBoardX(event) {
    const rect = board.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * WIDTH;
  }

  board.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (state === "idle" || state === "over") return;
    steerActive = true;
    steerTargetX = pointerToBoardX(event);
  });

  board.addEventListener("pointermove", (event) => {
    if (!steerActive) return;
    steerTargetX = pointerToBoardX(event);
  });

  function stopSteer() {
    steerActive = false;
  }
  board.addEventListener("pointerup", stopSteer);
  board.addEventListener("pointercancel", stopSteer);
  board.addEventListener("pointerleave", stopSteer);

  // --- Boot --------------------------------------------------------------------

  best = readBest();
  reset();
  draw();
  showOverlay("start");
})();
