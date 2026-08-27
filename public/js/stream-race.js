// /<channel>/statistics/chat - "Гонка": five of today's chatters race across the channel's own
// stream chart, right to left, with the chart's two lines as the ground under them.
//
// Deliberately NOT one of the site's games. It has no page in /games, no GameScores row, no run
// token and no replay: nothing it produces is kept, so there is nothing to cheat for. That is
// also why it is entirely client-side - the server's only involvement is deciding whether the
// button exists at all and handing over the pool of names (routes/statistics.js's buildRacePool).
//
// Three things about it are not obvious from the code:
//
//   - The track is READ OFF THE RENDERED CHART, not rebuilt from the data. stream-chart.js tags
//     its two curves with data-series, and this file samples those <path> elements with
//     getPointAtLength(). So the ground is always exactly the line the viewer can see, and a
//     future change to how the chart is drawn moves the track with it for free.
//   - The floor is the UPPER ENVELOPE of the two lines - at every column, whichever line is
//     higher on screen. The two series have independent y-axes and cross constantly, so neither
//     one alone is a continuous surface; the envelope is, which is what guarantees a race can
//     always finish. It also turns the message line's spikes into the towers worth watching
//     someone fail to climb.
//   - Nobody drives. Each runner gets random impulses, always leftward (see IMPULSE_* below),
//     and the physics decides what that is worth on the terrain it lands on.
//
// Coordinates: everything is in CSS pixels of the arena box, NOT the chart's viewBox units. The
// chart is drawn with preserveAspectRatio="none", so its 800x200 user space is stretched by a
// different factor on each axis and at every viewport width - a circle drawn in those units
// would render as an ellipse. Sampling converts to pixels once, up front.
(function () {
  "use strict";

  const dataEl = document.getElementById("stats-chat-data");
  if (!dataEl) return;

  let boot;
  try {
    boot = JSON.parse(dataEl.textContent);
  } catch (_) {
    return;
  }
  if (!boot || !boot.canRace) return;

  const $ = (id) => document.getElementById(id);
  const svg = $("stream-chart");
  const arena = $("stream-race-arena");
  const startBtn = $("stream-race-btn");
  const select = $("stream-session-select");
  const tooltip = $("stream-chart-tooltip");
  const modal = $("stream-race-results");
  const resultsList = $("stream-race-results-list");

  // Markup predating this script, or a chart that never rendered - stay inert rather than
  // throwing and taking the rest of the page's scripts down with us.
  if (!svg || !arena || !startBtn || !modal || !resultsList) return;

  const pool = Array.isArray(boot.racePool) ? boot.racePool : [];
  const labels = boot.raceLabels || {};

  // -----------------------------------------------------------------------------------------
  // Tunables. All of it lives here rather than inline, because none of these numbers were
  // derived - they were measured against real chart profiles until the race read well, and the
  // next person to retune them should not have to hunt through the integrator to do it.
  // -----------------------------------------------------------------------------------------

  const ARENA_HEIGHT_PX = 384; // the chart's normal h-48 (192px) is too flat a slot to race in
  const EXPAND_MS = 250; // must match the inline height transition set in expand()
  const COLUMN_PX = 2; // terrain resolution; also the width of the steepest wall we can represent
  const BALL_R = 14;
  const RACERS = 5;

  const GRAVITY = 1600; // px/s^2

  // Bounce off the ground. Low: a runner that lands should stay landed, not pogo down the hill.
  const RESTITUTION = 0.35;

  // Grip (static) is deliberately far higher than rolling resistance (kinetic). That gap is what
  // the "they should be able to slowly climb steep hills" behaviour is made of: an impulse
  // carries a runner part-way up a face, and grip parks it there instead of letting it slide
  // straight back down, so the next impulse starts from where the last one ended. MU_STATIC 1.2
  // holds any slope up to ~50 degrees; the message line's spikes are steeper than that and shed
  // runners on purpose.
  const MU_STATIC = 1.2;
  const ROLL_MU = 0.28;
  const STATIC_EPS = 22; // px/s below which grip is allowed to latch a runner in place

  // Rolling resistance is tuned for RACE LENGTH, not for a real steel ball: a frictionless run
  // down this profile takes about three seconds, which would leave the ray at 30s a mechanic
  // that never fires. At this value the terrain still decides who runs and who grinds, but the
  // impulses do most of the propelling.
  //
  // MAX_SPEED is load-bearing for the same reason and is far more sensitive than it looks: over
  // 25 simulated races on a representative profile, 900 gives a median finish around 11s with the
  // ray claiming someone in 1 race in 5, while 560 collapses the whole thing - only half the
  // field finishes at all and the ray becomes the usual way a race ends rather than the threat
  // that makes the last stretch worth watching. Re-measure before moving it.
  const MAX_SPEED = 900;
  const SUBSTEP = 1 / 240; // fixed - the physics must not change with the monitor's refresh rate
  const MAX_FRAME_DT = 0.1; // a backgrounded tab must not resume by simulating the gap at once

  const IMPULSE_MIN_S = 0.4;
  const IMPULSE_MAX_S = 1.2;
  const JUMP_CHANCE = 0.4;
  const PUSH_MIN = 220;
  const PUSH_MAX = 470;
  const JUMP_MIN = 430;
  const JUMP_MAX = 720;

  // Anti-stuck. Without it a runner pinned against a spike can burn the whole race there; the
  // envelope guarantees a walkable surface exists, not that random impulses will find it.
  const STUCK_WINDOW_S = 2;
  const STUCK_DX = 15;
  const STUCK_PUSH = 520;
  const STUCK_JUMP = 780;

  const RAY_START_S = 30;
  const RAY_SWEEP_S = 12; // full arena width, so no race can outlive RAY_START_S + RAY_SWEEP_S

  const COYOTE_S = 0.08; // grace after the last contact during which a jump still counts as grounded
  const RESULTS_DELAY_MS = 700; // let the last finish/explosion land before the modal covers it

  // Avatars are fetched and DECODED before the first frame, never during the race. Image decode
  // is main-thread work, and the race saturates the main thread with a 240Hz fixed-step loop:
  // measured in Chromium, requesting the avatars at race start left only 1-2 of 4 decoded three
  // and a half seconds in, so runners spent the opening of every race as blank monograms. The
  // cap keeps a slow CDN from holding the start line - whatever has not arrived by then simply
  // races as a monogram, which is the same fallback a dead avatar URL gets.
  const AVATAR_PRELOAD_CAP_MS = 900;

  const SOUND_BASE = "/sounds/stream-race/";
  const SOUND_VOLUME = 0.35; // fixed by design - this page has no volume slider
  const JUMP_SOUND_MIN_GAP_MS = 250; // five runners jumping freely is a stream of clicks otherwise

  const DEFAULT_COLOR = "#a78bfa";

  // -----------------------------------------------------------------------------------------
  // Sound. Built on first race rather than at load, so an owner who never presses the button
  // never downloads ~1MB of wav they did not ask for. cloneNode() per play is the same pattern
  // the site's games use, so overlapping plays layer instead of cutting each other off.
  // -----------------------------------------------------------------------------------------
  let sounds = null;
  let lastJumpSoundAt = 0;

  function ensureSounds() {
    if (sounds) return;
    sounds = {};
    for (const name of ["start", "jump", "finish", "ray", "destroy"]) {
      try {
        const audio = new Audio(SOUND_BASE + name + ".wav");
        audio.volume = SOUND_VOLUME;
        sounds[name] = audio;
      } catch (_) {
        /* audio unsupported - the race runs silently */
      }
    }
  }

  function playSound(name) {
    if (name === "jump") {
      const now = Date.now();
      if (now - lastJumpSoundAt < JUMP_SOUND_MIN_GAP_MS) return;
      lastJumpSoundAt = now;
    }
    const base = sounds && sounds[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      node.volume = SOUND_VOLUME;
      // Slight detune so the throttled jump clicks don't fuse into one mechanical stutter.
      if (name === "jump") node.playbackRate = 0.9 + Math.random() * 0.2;
      node.play().catch(() => {});
    } catch (_) {
      /* blocked/unsupported - keep racing */
    }
  }

  // -----------------------------------------------------------------------------------------
  // Terrain
  // -----------------------------------------------------------------------------------------

  const rand = (min, max) => min + Math.random() * (max - min);

  /**
   * Samples the two rendered chart curves into a single ground polyline in arena pixels.
   *
   * Both paths are walked by arc length rather than by x, which is what makes near-vertical
   * stretches survive: a spike gets many samples across the two pixels it occupies, so the
   * column it lands in ends up at the spike's TOP. Per column we keep the smallest y - smallest
   * being highest on screen - which is the upper envelope of the two series.
   *
   * Returns null when the chart has not rendered anything to stand on.
   */
  function sampleTerrain() {
    const rect = svg.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!(width > 0) || !(height > 0)) return null;

    const paths = svg.querySelectorAll("path[data-series]");
    if (paths.length === 0) return null;

    // The chart's own user-space box. Read from the attribute rather than hardcoded, so this
    // keeps working if stream-chart.js ever re-scales its plot.
    const viewBox = (svg.getAttribute("viewBox") || "0 0 800 200").split(/\s+/).map(Number);
    const vbW = viewBox[2] || 800;
    const vbH = viewBox[3] || 200;

    const columns = Math.floor(width / COLUMN_PX) + 1;
    const ys = new Array(columns).fill(Infinity);

    for (const path of paths) {
      let total = 0;
      try {
        total = path.getTotalLength();
      } catch (_) {
        continue;
      }
      if (!(total > 0)) continue;
      // Half a user unit per sample: dense enough that no 2px column of a steep run is skipped.
      const steps = Math.max(2, Math.ceil(total * 2));
      for (let i = 0; i <= steps; i++) {
        let point;
        try {
          point = path.getPointAtLength((total * i) / steps);
        } catch (_) {
          break;
        }
        const px = (point.x / vbW) * width;
        const py = (point.y / vbH) * height;
        const ci = Math.round(px / COLUMN_PX);
        if (ci < 0 || ci >= columns) continue;
        if (py < ys[ci]) ys[ci] = py;
      }
    }

    // Columns past either end of the data (the plot's right edge can sit slightly beyond the
    // last sample) and any interior gap are filled in, so the ground is continuous everywhere -
    // a hole in the floor is a runner lost off the bottom of the world.
    let firstKnown = -1;
    let lastKnown = -1;
    for (let i = 0; i < columns; i++) {
      if (ys[i] !== Infinity) {
        if (firstKnown < 0) firstKnown = i;
        lastKnown = i;
      }
    }
    if (firstKnown < 0) return null;
    for (let i = 0; i < firstKnown; i++) ys[i] = ys[firstKnown];
    for (let i = lastKnown + 1; i < columns; i++) ys[i] = ys[lastKnown];
    let gapStart = -1;
    for (let i = firstKnown; i <= lastKnown; i++) {
      if (ys[i] === Infinity) {
        if (gapStart < 0) gapStart = i;
        continue;
      }
      if (gapStart >= 0) {
        const left = ys[gapStart - 1];
        const span = i - gapStart + 1;
        for (let j = gapStart; j < i; j++) ys[j] = left + ((ys[i] - left) * (j - gapStart + 1)) / span;
        gapStart = -1;
      }
    }

    const points = new Array(columns);
    for (let i = 0; i < columns; i++) points[i] = { x: i * COLUMN_PX, y: ys[i] };
    return { points, width, height };
  }

  // -----------------------------------------------------------------------------------------
  // Physics
  // -----------------------------------------------------------------------------------------

  /**
   * Circle against the ground polyline, resolved against the deepest contact and re-checked.
   *
   * Segment collision rather than the usual "snap to the height under my centre": a height-field
   * lookup teleports a runner to the top of any near-vertical face it touches, which on this
   * terrain means every message spike becomes a free elevator. Closest-point-on-segment gives a
   * near-horizontal normal for those faces instead, so a spike pushes back the way a wall should.
   */
  function resolveGround(ball, terrain) {
    const points = terrain.points;
    let contact = null;

    for (let pass = 0; pass < 3; pass++) {
      const from = Math.max(0, Math.floor((ball.x - BALL_R) / COLUMN_PX) - 1);
      const to = Math.min(points.length - 2, Math.ceil((ball.x + BALL_R) / COLUMN_PX) + 1);

      let deepest = null;
      for (let i = from; i <= to; i++) {
        const a = points[i];
        const b = points[i + 1];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const lenSq = abx * abx + aby * aby;
        let t = lenSq === 0 ? 0 : ((ball.x - a.x) * abx + (ball.y - a.y) * aby) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = a.x + abx * t;
        const cy = a.y + aby * t;
        const dx = ball.x - cx;
        const dy = ball.y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq >= BALL_R * BALL_R) continue;
        const depth = BALL_R - Math.sqrt(distSq);
        if (!deepest || depth > deepest.depth) deepest = { depth, dx, dy, dist: BALL_R - depth };
      }
      if (!deepest) break;

      // Dead centre on the surface (dist 0) has no usable direction - push straight up, which is
      // the only sane guess and cannot happen twice in a row once the runner has been moved.
      let nx = 0;
      let ny = -1;
      if (deepest.dist > 0.0001) {
        nx = deepest.dx / deepest.dist;
        ny = deepest.dy / deepest.dist;
      }

      ball.x += nx * deepest.depth;
      ball.y += ny * deepest.depth;

      const vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= (1 + RESTITUTION) * vn * nx;
        ball.vy -= (1 + RESTITUTION) * vn * ny;
      }
      contact = { nx, ny };
    }

    return contact;
  }

  function stepBall(ball, terrain, dt) {
    ball.vy += GRAVITY * dt;

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > MAX_SPEED) {
      ball.vx = (ball.vx / speed) * MAX_SPEED;
      ball.vy = (ball.vy / speed) * MAX_SPEED;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Both side walls, for the full height of the column - including the open sky above the plot.
    // There is still no ceiling on purpose: a runner launched over the top keeps being simulated
    // and simply stops being drawn. But the sky has no floor and therefore no friction, so a
    // runner up there is a pure projectile carrying its full horizontal speed, and without a left
    // wall it would sail clean across the arena and cross the finish line unseen - measured, this
    // was winning roughly one race in five, with the winner never appearing on screen at all.
    // Walled in, it bounces, gravity brings it back down, and it finishes where people can see it.
    const rightLimit = terrain.width - BALL_R;
    if (ball.x > rightLimit) {
      ball.x = rightLimit;
      if (ball.vx > 0) ball.vx = -ball.vx * RESTITUTION;
    }
    if (ball.x < BALL_R) {
      ball.x = BALL_R;
      if (ball.vx < 0) ball.vx = -ball.vx * RESTITUTION;
    }

    const contact = resolveGround(ball, terrain);

    if (contact) {
      const nx = contact.nx;
      const ny = contact.ny;
      // Only a surface actually facing upward counts as ground to jump from; the flank of a
      // spike does not.
      if (ny < -0.3) ball.groundedFor = COYOTE_S;

      const tx = -ny;
      const ty = nx;
      let vt = ball.vx * tx + ball.vy * ty;
      const vn = ball.vx * nx + ball.vy * ny;

      const normalLoad = GRAVITY * Math.abs(ny);
      const slide = Math.abs(nx) - MU_STATIC * Math.abs(ny);
      if (Math.abs(vt) < STATIC_EPS && slide <= 0) {
        vt = 0; // grip holds it where the last impulse left it
      } else {
        const drop = ROLL_MU * normalLoad * dt;
        vt = Math.abs(vt) <= drop ? 0 : vt - Math.sign(vt) * drop;
      }

      ball.vx = vn * nx + vt * tx;
      ball.vy = vn * ny + vt * ty;
    } else if (ball.groundedFor > 0) {
      ball.groundedFor -= dt;
    }

    // Rolling without slipping, for the avatar's spin. Purely cosmetic.
    ball.angle += (ball.vx / BALL_R) * dt;
  }

  function fireImpulse(ball) {
    const grounded = ball.groundedFor > 0;
    if (grounded && Math.random() < JUMP_CHANCE) {
      ball.vy -= rand(JUMP_MIN, JUMP_MAX);
      ball.groundedFor = 0;
      playSound("jump");
      return;
    }
    // Always leftward. Nobody in this race wants to go back up their own stream.
    ball.vx -= rand(PUSH_MIN, PUSH_MAX);
  }

  // -----------------------------------------------------------------------------------------
  // Runners
  // -----------------------------------------------------------------------------------------

  function safeCssUrl(url) {
    if (typeof url !== "string") return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return url.replace(/["'()\\\s]/g, "");
  }

  // Runners bunch up constantly - at the start gate, in every dip, and against every spike - and
  // five 120px-wide name labels centred under five 28px discs turn into an unreadable smear the
  // moment two of them share an x. Staggering the labels over three rows by lane index keeps a
  // pile-up legible while holding every name within 26px of its own runner.
  const LABEL_ROWS = 3;
  const LABEL_ROW_PX = 11;
  const LABEL_W = 120;

  function buildBallElement(racer, lane) {
    const color = racer.color || DEFAULT_COLOR;

    const wrap = document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.left = "0";
    wrap.style.top = "0";
    wrap.style.willChange = "transform";

    const disc = document.createElement("div");
    disc.style.position = "absolute";
    disc.style.left = -BALL_R + "px";
    disc.style.top = -BALL_R + "px";
    disc.style.width = BALL_R * 2 + "px";
    disc.style.height = BALL_R * 2 + "px";
    disc.style.borderRadius = "50%";
    disc.style.overflow = "hidden";
    disc.style.background = color;
    disc.style.border = "2px solid " + color;
    disc.style.boxShadow = "0 0 0 1px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.5)";
    disc.style.display = "flex";
    disc.style.alignItems = "center";
    disc.style.justifyContent = "center";
    disc.style.fontSize = "13px";
    disc.style.fontWeight = "700";
    disc.style.color = "#0a0a0a";

    // The monogram is the BASE layer, not a fallback branch: the avatar <img> sits on top of it
    // and removes itself if the CDN fails, which uncovers the letter with no extra bookkeeping.
    disc.textContent = (racer.userName || "?").charAt(0).toUpperCase();

    const url = safeCssUrl(racer.avatarUrl);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.style.position = "absolute";
      img.style.inset = "0";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.onerror = () => img.remove();
      disc.appendChild(img);
    }

    const label = document.createElement("div");
    label.style.position = "absolute";
    label.style.left = -LABEL_W / 2 + "px"; // re-clamped every frame in draw()
    label.style.top = BALL_R + 4 + (lane % LABEL_ROWS) * LABEL_ROW_PX + "px";
    label.style.width = LABEL_W + "px";
    label.style.textAlign = "center";
    label.style.lineHeight = "1";
    label.style.pointerEvents = "none";

    // The name sits on its own chip rather than bare on the chart: it is drawn over two coloured
    // lines and a gridline, and a text shadow alone loses against the red one.
    const chip = document.createElement("span");
    chip.style.display = "inline-block";
    chip.style.maxWidth = LABEL_W - 4 + "px";
    chip.style.padding = "1px 4px";
    chip.style.borderRadius = "4px";
    chip.style.background = "rgba(10,10,10,.8)";
    chip.style.fontSize = "10px";
    chip.style.fontWeight = "600";
    chip.style.color = color;
    chip.style.whiteSpace = "nowrap";
    chip.style.overflow = "hidden";
    chip.style.textOverflow = "ellipsis";
    chip.textContent = racer.userName || "?";
    label.appendChild(chip);

    wrap.append(disc, label);
    return { wrap, disc, label };
  }

  // Warmed during the expand transition (see the button handler), which is dead time anyway.
  let avatarsReady = null;

  function preloadAvatars() {
    if (avatarsReady) return avatarsReady;
    const urls = [];
    for (const racer of pool) {
      const url = safeCssUrl(racer.avatarUrl);
      if (url && urls.indexOf(url) === -1) urls.push(url);
    }
    if (urls.length === 0) {
      avatarsReady = Promise.resolve();
      return avatarsReady;
    }
    avatarsReady = new Promise((resolve) => {
      let pending = urls.length;
      const settle = () => {
        if (--pending <= 0) resolve();
      };
      for (const url of urls) {
        const img = new Image();
        img.onload = settle;
        img.onerror = settle;
        img.src = url;
      }
      setTimeout(resolve, AVATAR_PRELOAD_CAP_MS);
    });
    return avatarsReady;
  }

  function pickRacers() {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    return shuffled.slice(0, Math.min(RACERS, shuffled.length));
  }

  // -----------------------------------------------------------------------------------------
  // Effects
  // -----------------------------------------------------------------------------------------

  function flash(x, y, color) {
    const node = document.createElement("div");
    node.style.position = "absolute";
    node.style.left = x - 6 + "px";
    node.style.top = y - 6 + "px";
    node.style.width = "12px";
    node.style.height = "12px";
    node.style.borderRadius = "50%";
    node.style.background = color;
    node.style.pointerEvents = "none";
    arena.appendChild(node);
    try {
      const anim = node.animate(
        [
          { transform: "scale(0.4)", opacity: 1 },
          { transform: "scale(5)", opacity: 0 },
        ],
        { duration: 420, easing: "ease-out" }
      );
      anim.onfinish = () => node.remove();
    } catch (_) {
      node.remove(); // no Web Animations - skip the effect rather than leaving a dot behind
    }
  }

  function buildRayElement() {
    const node = document.createElement("div");
    node.style.position = "absolute";
    node.style.top = "0";
    node.style.bottom = "0";
    node.style.width = "6px";
    node.style.marginLeft = "-3px";
    node.style.pointerEvents = "none";
    node.style.background = "linear-gradient(90deg, rgba(248,113,113,0) 0%, #f87171 35%, #fff 50%, #f87171 65%, rgba(248,113,113,0) 100%)";
    node.style.boxShadow = "0 0 12px 4px rgba(248,113,113,.75)";
    return node;
  }

  // -----------------------------------------------------------------------------------------
  // Race state machine
  // -----------------------------------------------------------------------------------------

  let running = false;
  let expanded = false;
  let terrain = null;
  let balls = [];
  let results = [];
  let raceT = 0;
  let rayEl = null;
  let raySeen = false;
  let rafId = 0;
  let lastFrameAt = 0;

  function expand(done) {
    if (expanded) {
      done();
      return;
    }
    expanded = true;
    svg.style.transition = "height " + EXPAND_MS + "ms ease";
    svg.style.height = ARENA_HEIGHT_PX + "px";

    // The terrain must be sampled from the SETTLED geometry - taking it mid-transition would
    // measure a track shorter than the one the runners then race on.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      svg.removeEventListener("transitionend", onEnd);
      done();
    };
    const onEnd = (event) => {
      if (event.propertyName === "height") finish();
    };
    svg.addEventListener("transitionend", onEnd);
    setTimeout(finish, EXPAND_MS + 120); // transitionend never fires if the height didn't change
  }

  function collapse() {
    expanded = false;
    svg.style.height = "";
    svg.style.transition = "";
  }

  function lockChart(locked) {
    svg.style.pointerEvents = locked ? "none" : "";
    if (select) select.disabled = locked;
    if (locked && tooltip) tooltip.classList.add("hidden");
  }

  function startRace() {
    const sampled = sampleTerrain();
    if (!sampled) {
      lockChart(false);
      collapse();
      return;
    }
    terrain = sampled;

    arena.textContent = "";
    arena.hidden = false;
    balls = [];
    results = [];
    raceT = 0;
    raySeen = false;
    rayEl = null;

    // One start point for everyone, as a starting gate should be. They separate immediately
    // because every runner's first impulse fires on the first step with its own random strength -
    // without that they would move as one indistinguishable blob for the first half-second.
    const startX = terrain.width - BALL_R - 4;
    const startY = BALL_R + 4;

    pickRacers().forEach((racer, lane) => {
      const el = buildBallElement(racer, lane);
      arena.appendChild(el.wrap);
      balls.push({
        racer,
        wrap: el.wrap,
        disc: el.disc,
        label: el.label,
        labelLeft: null,
        x: startX,
        y: startY,
        vx: 0,
        vy: 0,
        angle: 0,
        groundedFor: 0,
        nextImpulse: 0,
        stuckTimer: 0,
        stuckX: startX,
        state: "running",
      });
    });
    if (balls.length === 0) {
      arena.hidden = true;
      lockChart(false);
      collapse();
      return;
    }

    ensureSounds();
    playSound("start");

    running = true;
    lastFrameAt = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function finishBall(ball) {
    ball.state = "finished";
    ball.x = BALL_R;
    ball.vx = 0;
    ball.vy = 0;
    // Frozen where it crossed: no more physics, and out of the ray's reach for good.
    results.push({ racer: ball.racer, time: raceT, destroyed: false });
    playSound("finish");
    flash(ball.x, ball.y, "#a3e635");
  }

  function destroyBall(ball) {
    ball.state = "destroyed";
    results.push({ racer: ball.racer, time: raceT, destroyed: true });
    // A runner launched above the plot is invisible but still very much in the race, so its
    // death gets marked on the top edge instead of nowhere.
    const y = ball.y < 6 ? 6 : Math.min(ball.y, terrain.height - 6);
    flash(ball.x, y, "#f87171");
    playSound("destroy");
    ball.wrap.remove();
  }

  function frame(now) {
    if (!running) return;

    let dt = (now - lastFrameAt) / 1000;
    lastFrameAt = now;
    if (!(dt > 0)) dt = SUBSTEP;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    simulate(dt);
    draw();

    const done = balls.every((b) => b.state !== "running");
    if (done) {
      running = false;
      setTimeout(showResults, RESULTS_DELAY_MS);
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function simulate(dt) {
    let remaining = dt;
    while (remaining > 0) {
      const step = Math.min(SUBSTEP, remaining);
      remaining -= step;
      raceT += step;

      for (const ball of balls) {
        if (ball.state !== "running") continue;

        ball.nextImpulse -= step;
        if (ball.nextImpulse <= 0) {
          fireImpulse(ball);
          ball.nextImpulse = rand(IMPULSE_MIN_S, IMPULSE_MAX_S);
        }

        ball.stuckTimer += step;
        if (ball.stuckTimer >= STUCK_WINDOW_S) {
          if (Math.abs(ball.x - ball.stuckX) < STUCK_DX) {
            ball.vx -= STUCK_PUSH;
            ball.vy -= STUCK_JUMP;
            ball.groundedFor = 0;
            playSound("jump");
          }
          ball.stuckTimer = 0;
          ball.stuckX = ball.x;
        }

        stepBall(ball, terrain, step);

        // Safety net for the one thing segment collision can still miss - a runner that somehow
        // ends up underneath the ground is lifted back onto it rather than falling forever.
        const ci = Math.max(0, Math.min(terrain.points.length - 1, Math.round(ball.x / COLUMN_PX)));
        if (ball.y > terrain.points[ci].y + BALL_R * 2) {
          ball.y = terrain.points[ci].y - BALL_R;
          ball.vy = 0;
        }

        // Reaching the left edge only counts while the runner is actually inside the arena - the
        // other half of the fix above. A runner still up in the sky bounces off the wall instead
        // of finishing, and claims its place on the way back down.
        if (ball.x <= BALL_R && ball.y + BALL_R >= 0) {
          finishBall(ball);
          continue;
        }
      }

      if (raceT >= RAY_START_S) {
        if (!raySeen) {
          raySeen = true;
          rayEl = buildRayElement();
          arena.appendChild(rayEl);
          playSound("ray");
        }
        const rayX = terrain.width - ((raceT - RAY_START_S) / RAY_SWEEP_S) * terrain.width;
        rayEl.style.left = rayX + "px";
        for (const ball of balls) {
          if (ball.state !== "running") continue;
          if (ball.x + BALL_R >= rayX) destroyBall(ball);
        }
      }
    }
  }

  function draw() {
    for (const ball of balls) {
      if (ball.state === "destroyed") continue;
      // "Stops being drawn above the top edge" - the simulation carries on regardless, so a
      // runner that comes back down rejoins the race exactly where the physics put it.
      const hidden = ball.y + BALL_R < 0;
      ball.wrap.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) continue;
      ball.wrap.style.transform = "translate(" + ball.x.toFixed(1) + "px," + ball.y.toFixed(1) + "px)";
      ball.disc.style.transform = "rotate(" + ball.angle.toFixed(2) + "rad)";

      // Names are 120px wide and centred on a runner that spends the start pinned to the right
      // edge and the finish pinned to the left one, so a plain centred label loses half of itself
      // to the arena's overflow clip at exactly the two moments it matters most - the gate and
      // the finish line. Clamped into the arena instead, and only written when it actually moves.
      const clamped = Math.max(2, Math.min(terrain.width - LABEL_W - 2, ball.x - LABEL_W / 2));
      const left = Math.round(clamped - ball.x);
      if (left !== ball.labelLeft) {
        ball.labelLeft = left;
        ball.label.style.left = left + "px";
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Results
  // -----------------------------------------------------------------------------------------

  function orderedResults() {
    const finishers = results.filter((r) => !r.destroyed).sort((a, b) => a.time - b.time);
    // The ray sweeps right to left, so whoever it reached LAST was furthest along: death order
    // reversed is already standings order, with nothing to measure.
    const destroyed = results.filter((r) => r.destroyed).sort((a, b) => b.time - a.time);
    return finishers.concat(destroyed);
  }

  function showResults() {
    resultsList.textContent = "";
    orderedResults().forEach((row, index) => {
      const place = index + 1;
      const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : place === 3 ? "🥉" : null;

      const li = document.createElement("li");
      li.className = "flex items-center gap-3 px-5 py-2.5";

      const rank = document.createElement("span");
      rank.className = medal
        ? "w-6 shrink-0 text-center text-base"
        : "w-6 shrink-0 text-center text-xs text-neutral-600 tabular-nums";
      rank.textContent = medal || String(place);

      // Same monogram-underneath-the-avatar arrangement the runners use, so a CDN miss degrades
      // to a letter here too instead of a hole in the standings.
      const avatar = document.createElement("div");
      avatar.className = "relative w-7 h-7 rounded-full shrink-0 overflow-hidden";
      avatar.style.background = row.racer.color || DEFAULT_COLOR;

      const mono = document.createElement("span");
      mono.className = "absolute inset-0 flex items-center justify-center text-xs font-bold text-neutral-900";
      mono.textContent = (row.racer.userName || "?").charAt(0).toUpperCase();
      avatar.appendChild(mono);

      const url = safeCssUrl(row.racer.avatarUrl);
      if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.className = "absolute inset-0 w-full h-full object-cover";
        img.onerror = () => img.remove();
        avatar.appendChild(img);
      }

      const name = document.createElement("span");
      name.className = "truncate flex-1 min-w-0 text-sm";
      if (row.racer.color) name.style.color = row.racer.color;
      else name.classList.add("text-neutral-200");
      name.textContent = row.racer.userName || "?";

      const outcome = document.createElement("span");
      outcome.className = row.destroyed
        ? "text-xs text-red-400/80 shrink-0"
        : "text-xs text-neutral-500 tabular-nums shrink-0";
      outcome.textContent = row.destroyed
        ? labels.destroyed || "destroyed"
        : row.time.toFixed(1) + (labels.secondsSuffix || "s");

      li.append(rank, avatar, name, outcome);
      resultsList.appendChild(li);
    });

    modal.hidden = false;
  }

  function closeRace() {
    modal.hidden = true;
    running = false;
    cancelAnimationFrame(rafId);
    arena.textContent = "";
    arena.hidden = true;
    lockChart(false);
    collapse();
  }

  function raceAgain() {
    modal.hidden = true;
    cancelAnimationFrame(rafId);
    startRace();
  }

  // -----------------------------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------------------------

  startBtn.addEventListener("click", () => {
    if (running) return;
    lockChart(true);
    const ready = preloadAvatars();
    expand(() => ready.then(startRace));
  });

  const closeBtn = $("stream-race-results-close");
  const okBtn = $("stream-race-ok");
  const againBtn = $("stream-race-again");
  if (closeBtn) closeBtn.addEventListener("click", closeRace);
  if (okBtn) okBtn.addEventListener("click", closeRace);
  if (againBtn) againBtn.addEventListener("click", raceAgain);
})();
