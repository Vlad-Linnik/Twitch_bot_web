// /<channel>/statistics/chat - "Гонка": five of today's chatters race across the channel's own
// stream chart, right to left, with the chart's two lines as the ground under them.
//
// Deliberately NOT one of the site's games. It has no page in /games, no GameScores row, no run
// token and no replay: nothing it produces is kept, so there is nothing to cheat for. That is
// also why it is entirely client-side - the server's only involvement is deciding whether the
// button exists at all and handing over the pool of names (routes/statistics.js's buildRacePool).
//
// Four things about it are not obvious from the code:
//
//   - The track is READ OFF THE RENDERED CHART, not rebuilt from the data: this file parses the
//     `d` attribute of the two <path> elements stream-chart.js tags with data-series. So the
//     ground is always exactly the line the viewer can see, and a future change to how the chart
//     is drawn moves the track with it for free. See parsePathCubics() for why it reads the
//     attribute by hand instead of asking the SVG DOM to measure the curve.
//   - The floor is the UPPER ENVELOPE of the two lines - at every column, whichever line is
//     higher on screen. The two series have independent y-axes and cross constantly, so neither
//     one alone is a continuous surface; the envelope is, which is what guarantees a race can
//     always finish.
//   - Race mode widens the chart to the full viewport and takes its height FROM that width, so
//     the drawn curve keeps the shape it has at rest instead of being stretched vertically. The
//     track therefore changes size with the viewer's screen, which is why every physics constant
//     below is scaled to the measured track width - otherwise the same race would play out
//     completely differently on a 1280 monitor and a 2560 one.
//   - Nobody drives. Each runner gets random impulses, always leftward, and the physics decides
//     what that is worth on the terrain it lands on.
//
// Coordinates: everything is in CSS pixels of the arena box, NOT the chart's viewBox units. The
// chart is drawn with preserveAspectRatio="none", so its 800x200 user space is stretched by a
// different factor on each axis - a circle drawn in those units would render as an ellipse.
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
  const card = $("stream-chart-wrap");
  const arena = $("stream-race-arena");
  const startBtn = $("stream-race-btn");
  const select = $("stream-session-select");
  const tooltip = $("stream-chart-tooltip");
  const modal = $("stream-race-results");
  const resultsList = $("stream-race-results-list");

  // Markup predating this script, or a chart that never rendered - stay inert rather than
  // throwing and taking the rest of the page's scripts down with us.
  if (!svg || !card || !arena || !startBtn || !modal || !resultsList) return;

  const pool = Array.isArray(boot.racePool) ? boot.racePool : [];
  const labels = boot.raceLabels || {};

  // -----------------------------------------------------------------------------------------
  // Tunables. All of it lives here rather than inline, because none of these numbers were
  // derived - they were measured against real chart profiles until the race read well, and the
  // next person to retune them should not have to hunt through the integrator to do it.
  //
  // Everything with a LENGTH dimension (speeds, accelerations, impulse strengths, the ball) is
  // written against REFERENCE_WIDTH and multiplied by the measured track width over it at race
  // start. Scaling velocity and acceleration by the same factor as length is what keeps a race
  // the same LENGTH IN SECONDS on every screen; leaving them fixed would make a wide monitor a
  // marathon and a narrow one a sprint.
  // -----------------------------------------------------------------------------------------

  const REFERENCE_WIDTH = 900;

  // Race-mode layout. The chart breaks out of the page's max-width column to (nearly) the full
  // viewport and derives its height from that width, holding the aspect ratio it has at rest.
  const RACE_GUTTER_PX = 24; // breathing room on each side of the full-bleed card
  const RACE_MAX_VH = 0.62; // ceiling on the arena's height, so the track still fits on screen
  const EXPAND_MS = 250; // must match the transition set in enterRaceLayout()

  const COLUMN_PX = 2; // terrain resolution; also the width of the steepest wall we can represent

  const BALL_R_BASE = 15;
  const BALL_R_MIN = 12;
  // Capped well below what the width scaling alone would give. A big disc resting on a steep face
  // sits its own radius away from the line along the normal, which reads as the runner hovering
  // beside the chart rather than standing on it.
  const BALL_R_MAX = 20;
  const RACERS = 5;

  const GRAVITY_BASE = 1600; // px/s^2

  // Bounce off the ground, kept low on purpose: these are supposed to crawl the terrain, and a
  // springy runner skips over exactly the slopes it should be grinding up.
  const RESTITUTION = 0.18;

  // These CLING rather than obey a friction cone: below STATIC_EPS along the surface a runner
  // latches wherever it is, at any angle, a sheer face included. That is not a friction model and
  // is not pretending to be one - it is the snail, and it is what makes this terrain climbable at
  // all. Under real Coulomb friction a runner slid back down anything past its hold angle, so a
  // one-bucket message spike (a sheer wall around 139px tall, against a jump that clears 78px)
  // was not an obstacle but a gate: whoever bounced over it was home in six seconds while the
  // rest ground against it until the ray arrived. Clinging means an impulse's gain is KEPT, so
  // the next one starts where the last ended and a spike costs the whole field a slow climb.
  //
  // The first fix for that gate was slope-limiting the ground into ramps. It worked and looked
  // wrong: raising the floor beside a peak left runners visibly hovering next to the chart rather
  // than standing on it. Climbing the real line is the version that also reads correctly.
  const ROLL_MU = 0.29;

  // Contact tolerance, in pixels. Not a tuning knob - see resolveGround().
  const CONTACT_SKIN = 1.5;
  const STATIC_EPS_BASE = 22; // speed below which grip is allowed to latch a runner in place

  const MAX_SPEED_BASE = 380;
  const SUBSTEP = 1 / 240; // fixed - the physics must not change with the monitor's refresh rate
  const MAX_FRAME_DT = 0.1; // a backgrounded tab must not resume by simulating the gap at once

  // Many small nudges rather than a few big ones. Long gaps between strong impulses read as
  // lurching, and a tall jump lets one runner clear half the map in a single hop and settle the
  // race before it has started - the pace should come from grinding forward, not from leaping.
  //
  // The push range is deliberately NARROW (114..143 rather than something like 80..177 at the
  // same average). Both tune to the same race length, but the wide range spreads the field out:
  // measured over 12 races each, the wide one had the leader home anywhere between 20s and 29s,
  // the narrow one between 18s and 24s, with correspondingly fewer runners left behind for the
  // ray. The variety that makes a race worth watching comes from the terrain and from the
  // push/jump choice, not from how hard any one nudge happens to land.
  //
  // Calibrated so the FIRST runner home averages ~25s (see the header note on scaling: this holds
  // at any track width). Pace is extremely sensitive here - the same constants at PUSH 260/520
  // and ROLL_MU 0.15 put the winner home in 3 seconds.
  const IMPULSE_MIN_S = 0.25;
  const IMPULSE_MAX_S = 0.7;
  const JUMP_CHANCE = 0.22;
  const PUSH_MIN_BASE = 114;
  const PUSH_MAX_BASE = 143;
  const JUMP_MIN_BASE = 95;
  const JUMP_MAX_BASE = 165;

  // What a push is worth when it is aimed up a slope rather than along the flat: nothing extra on
  // the level, this much extra straight up a wall.
  //
  // A push spent climbing buys height as v^2/2g, and the square is brutal at this scale - the
  // same nudge that carries a runner a clear stride along the flat lifts it about ten pixels up
  // a sheer face. So a 240px message spike cost twenty-odd impulses, eleven seconds of a
  // thirty-second race, with the ray already on its way. Measured across eight generated chart
  // profiles, without this: 57% of runners reached the finish, and on the four profiles whose
  // envelope trends uphill right-to-left only 18% did - those were gates rather than races,
  // which is the complaint this answers. With it: 89% and 78%.
  //
  // SQUARED, not linear, and that is the part that matters. The boost has to reach only the
  // slopes that are genuinely impassable: a gentle rise is already walkable, and paying a bonus
  // on it just shortens the race everywhere. Linear at the strength needed to clear a wall put
  // the first runner home in 18s against a design pace of 25; squared, the same strength leaves
  // that at 25.0s while still clearing the wall, because a half-steep slope collects a quarter
  // of the bonus rather than half of it.
  //
  // Scaling the push rather than adding a separate climbing term is what leaves the flat-ground
  // pace untouched - on the level the whole term is multiplied by zero.
  const CLIMB_ASSIST = 2;

  // Anti-stuck. Without it a runner pinned against a spike can burn the whole race there; the
  // envelope guarantees a walkable surface exists, not that random impulses will find it.
  const STUCK_WINDOW_S = 2;
  const STUCK_DX_BASE = 15;
  const STUCK_PUSH_BASE = 330;
  const STUCK_JUMP_BASE = 430;

  const RAY_START_S = 30;
  const RAY_SWEEP_S = 12; // full arena width, so no race can outlive RAY_START_S + RAY_SWEEP_S

  const COYOTE_S = 0.08; // grace after the last contact during which a jump still counts as grounded
  const RESULTS_DELAY_MS = 700; // let the last finish/explosion land before the modal covers it

  const SOUND_BASE = "/sounds/stream-race/";
  const SOUND_VOLUME = 0.35; // fixed by design - this page has no volume slider
  const JUMP_SOUND_MIN_GAP_MS = 250; // five runners jumping freely is a stream of clicks otherwise

  const DEFAULT_COLOR = "#a78bfa";

  // Runners bunch up constantly - at the start gate, in every dip, and against every spike - and
  // five name labels centred under five discs turn into an unreadable smear the moment two of
  // them share an x. Staggering the labels over three rows by lane index keeps a pile-up legible
  // while holding every name close to its own runner.
  const LABEL_ROWS = 3;
  const LABEL_ROW_PX = 11;
  const LABEL_W = 120;

  // Scaled per race from the measured track width - see REFERENCE_WIDTH above.
  let P = null;

  function scaledPhysics(width) {
    const s = width / REFERENCE_WIDTH;
    return {
      scale: s,
      ballR: Math.max(BALL_R_MIN, Math.min(BALL_R_MAX, BALL_R_BASE * s)),
      gravity: GRAVITY_BASE * s,
      maxSpeed: MAX_SPEED_BASE * s,
      staticEps: STATIC_EPS_BASE * s,
      pushMin: PUSH_MIN_BASE * s,
      pushMax: PUSH_MAX_BASE * s,
      jumpMin: JUMP_MIN_BASE * s,
      jumpMax: JUMP_MAX_BASE * s,
      stuckDx: STUCK_DX_BASE * s,
      stuckPush: STUCK_PUSH_BASE * s,
      stuckJump: STUCK_JUMP_BASE * s,
    };
  }

  // -----------------------------------------------------------------------------------------
  // Sound
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
   * Parses a chart curve's `d` into cubic segments.
   *
   * The obvious way to walk a rendered path is getTotalLength()/getPointAtLength(), and that is
   * what this did first. It is unusably slow: Chromium re-walks the path's segment list on every
   * getPointAtLength call, so sampling densely is quadratic. Measured on a real message line
   * (~100 cubics, length 1888 user units), 3777 samples cost 4.2 SECONDS - a four-and-a-half
   * second freeze before every single race, "race again" included.
   *
   * stream-chart.js emits nothing but M, L and C (see its buildSmoothPath), so parsing the
   * attribute and evaluating the Beziers here is both exact and orders of magnitude cheaper.
   * Anything unexpected in the data returns null and that curve is skipped rather than guessed at.
   */
  function parsePathCubics(d) {
    const tokens = String(d || "").match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
    if (!tokens) return null;

    const segments = [];
    let command = null;
    let current = null;
    let i = 0;

    const num = () => {
      const value = Number(tokens[i++]);
      return Number.isFinite(value) ? value : null;
    };

    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i])) {
        command = tokens[i++];
        if (command !== "M" && command !== "L" && command !== "C") return null;
      }
      if (command === "M") {
        const x = num();
        const y = num();
        if (x === null || y === null) return null;
        current = { x, y };
        command = "L"; // an implicit lineto follows a moveto, per the SVG path grammar
        continue;
      }
      if (!current) return null;
      if (command === "L") {
        const x = num();
        const y = num();
        if (x === null || y === null) return null;
        const to = { x, y };
        segments.push({ p0: current, c1: current, c2: to, p1: to });
        current = to;
        continue;
      }
      const c1x = num();
      const c1y = num();
      const c2x = num();
      const c2y = num();
      const x = num();
      const y = num();
      if (c1x === null || c1y === null || c2x === null || c2y === null || x === null || y === null) {
        return null;
      }
      const to = { x, y };
      segments.push({ p0: current, c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, p1: to });
      current = to;
    }
    return segments.length ? segments : null;
  }

  /**
   * Samples the two rendered chart curves into a single ground polyline in arena pixels.
   *
   * Per column we keep the smallest y - smallest being highest on screen - which is the upper
   * envelope of the two series. Each cubic is sampled finely enough to cover the columns it
   * spans, with a floor for the near-vertical ones that cover almost no horizontal distance, so
   * a spike still lands its true top in the column it occupies instead of being stepped over.
   *
   * A vertex keeps the x of the sample that won its column, NOT the column's own x, and that is
   * the whole reason the ground matches the drawn line. A column collects every sample within
   * half a column of its centre, so on a slope of gradient m the highest of them is m pixels
   * above the curve at the centre - filing it under the centre's x lifts the whole face by that
   * much. Measured against real profiles before the x was kept: the ground ran up to 14px above
   * the message line and never once below it, so runners visibly hovered over every steep face
   * while the near-flat viewer line, where m is ~0, looked correct. Keeping the winning sample's
   * own x makes every vertex a point that actually lies on the curve, with no cost to spikes -
   * the topmost sample still wins its column either way.
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
    const sx = width / (viewBox[2] || 800);
    const sy = height / (viewBox[3] || 200);

    const columns = Math.floor(width / COLUMN_PX) + 1;
    const ys = new Array(columns).fill(Infinity);
    const xs = new Array(columns).fill(0);

    let sampled = false;
    for (const path of paths) {
      const segments = parsePathCubics(path.getAttribute("d"));
      if (!segments) continue;
      sampled = true;

      for (const seg of segments) {
        const spanPx = Math.abs(seg.p1.x - seg.p0.x) * sx;
        const steps = Math.max(6, Math.ceil((spanPx / COLUMN_PX) * 3));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const e = t * t * t;
          const px = (a * seg.p0.x + b * seg.c1.x + c * seg.c2.x + e * seg.p1.x) * sx;
          const py = (a * seg.p0.y + b * seg.c1.y + c * seg.c2.y + e * seg.p1.y) * sy;
          const ci = Math.round(px / COLUMN_PX);
          if (ci < 0 || ci >= columns) continue;
          if (py < ys[ci]) {
            ys[ci] = py;
            xs[ci] = px;
          }
        }
      }
    }
    if (!sampled) return null;

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
    // Filled columns have no sample of their own to take an x from, so they sit on their column
    // centre. Ordering survives it: a sampled x is at most half a column from its centre, so it
    // still falls strictly between its neighbours' centres.
    for (let i = 0; i < firstKnown; i++) {
      ys[i] = ys[firstKnown];
      xs[i] = i * COLUMN_PX;
    }
    for (let i = lastKnown + 1; i < columns; i++) {
      ys[i] = ys[lastKnown];
      xs[i] = i * COLUMN_PX;
    }
    let gapStart = -1;
    for (let i = firstKnown; i <= lastKnown; i++) {
      if (ys[i] === Infinity) {
        if (gapStart < 0) gapStart = i;
        continue;
      }
      if (gapStart >= 0) {
        const left = ys[gapStart - 1];
        const span = i - gapStart + 1;
        for (let j = gapStart; j < i; j++) {
          ys[j] = left + ((ys[i] - left) * (j - gapStart + 1)) / span;
          xs[j] = j * COLUMN_PX;
        }
        gapStart = -1;
      }
    }

    const points = new Array(columns);
    for (let i = 0; i < columns; i++) points[i] = { x: xs[i], y: ys[i] };
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
    const r = P.ballR;
    // Touching counts, not just overlapping. Collision resolution leaves a runner exactly tangent
    // to the surface, and a runner tangent to a SHEER face is not penetrating anything - so with
    // an overlap-only test it reported no contact at all, the cling never engaged, and it slid
    // straight back down every wall it had just climbed. Measured before this skin existed: all
    // five spent the whole race pinned at the foot of the same message spike.
    const reach = r + CONTACT_SKIN;
    let contact = null;

    for (let pass = 0; pass < 3; pass++) {
      const from = Math.max(0, Math.floor((ball.x - reach) / COLUMN_PX) - 1);
      const to = Math.min(points.length - 2, Math.ceil((ball.x + reach) / COLUMN_PX) + 1);

      let nearest = null;
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
        if (distSq >= reach * reach) continue;
        const dist = Math.sqrt(distSq);
        if (!nearest || dist < nearest.dist) nearest = { dist, dx, dy };
      }
      if (!nearest) break;

      // Dead centre on the surface (dist 0) has no usable direction - push straight up, which is
      // the only sane guess and cannot happen twice in a row once the runner has been moved.
      let nx = 0;
      let ny = -1;
      if (nearest.dist > 0.0001) {
        nx = nearest.dx / nearest.dist;
        ny = nearest.dy / nearest.dist;
      }
      contact = { nx, ny };

      // Inside the skin but not inside the surface: there is nothing to push out of, and the
      // contact is already recorded, so the passes are done.
      if (nearest.dist >= r) break;

      const depth = r - nearest.dist;
      ball.x += nx * depth;
      ball.y += ny * depth;

      const vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= (1 + RESTITUTION) * vn * nx;
        ball.vy -= (1 + RESTITUTION) * vn * ny;
      }
    }

    return contact;
  }

  function stepBall(ball, terrain, dt) {
    ball.vy += P.gravity * dt;

    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > P.maxSpeed) {
      ball.vx = (ball.vx / speed) * P.maxSpeed;
      ball.vy = (ball.vy / speed) * P.maxSpeed;
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
    const rightLimit = terrain.width - P.ballR;
    if (ball.x > rightLimit) {
      ball.x = rightLimit;
      if (ball.vx > 0) ball.vx = -ball.vx * RESTITUTION;
    }
    if (ball.x < P.ballR) {
      ball.x = P.ballR;
      if (ball.vx < 0) ball.vx = -ball.vx * RESTITUTION;
    }

    const contact = resolveGround(ball, terrain);

    if (contact) {
      const nx = contact.nx;
      const ny = contact.ny;
      // Touching anything at all is what "forward" is measured against; only a surface actually
      // facing upward is something you could jump off. The flank of a spike is the first and not
      // the second.
      ball.nx = nx;
      ball.ny = ny;
      ball.contactFor = COYOTE_S;
      if (ny < -0.3) ball.groundedFor = COYOTE_S;

      const tx = -ny;
      const ty = nx;
      let vt = ball.vx * tx + ball.vy * ty;
      const vn = ball.vx * nx + ball.vy * ny;

      if (Math.abs(vt) < P.staticEps && gravityAlongForward(ball, tx, ty) <= 0) {
        // The cling, and it only ever holds a runner against sliding BACKWARD. Clinging in both
        // directions was tried and is far worse than it sounds: it also cancels every descent, so
        // gravity stops contributing anything at all and the whole race is reduced to the sum of
        // its pushes - measured, not one runner in sixty reached the finish before the ray.
        vt = 0;
      } else {
        const drop = ROLL_MU * P.gravity * Math.abs(ny) * dt;
        vt = Math.abs(vt) <= drop ? 0 : vt - Math.sign(vt) * drop;
      }

      ball.vx = vn * nx + vt * tx;
      ball.vy = vn * ny + vt * ty;
    } else {
      if (ball.groundedFor > 0) ball.groundedFor -= dt;
      if (ball.contactFor > 0) ball.contactFor -= dt;
    }

    // Rolling without slipping, for the avatar's spin. Purely cosmetic.
    ball.angle += (ball.vx / P.ballR) * dt;
  }

  const groundYAt = (x) => {
    const i = Math.max(0, Math.min(terrain.points.length - 1, Math.round(x / COLUMN_PX)));
    return terrain.points[i].y;
  };

  /**
   * "Onward" for a runner: the direction of the track itself one ball-radius further along, not
   * the tangent of whatever surface it happens to be touching.
   *
   * Reading it off the contact normal was tried and fails in the exact case it exists for. The
   * collision picks the NEAREST piece of ground, and a runner standing at the foot of a message
   * spike is nearest to the flat ground under its feet, not to the wall in front of it - so
   * "forward" came out horizontal, the push went straight into the wall, and that runner stood
   * there for the entire race while the ones that happened to touch the wall first climbed it.
   * Looking ahead along the track sees the wall either way.
   *
   * On flat ground this is leftward, on a descent it points down the slope, and against a sheer
   * face it points almost straight up it - which is what turns a push into a climb, so a runner
   * scales a spike hugging the drawn line. Off the ground it degrades to plain leftward.
   */
  function forwardDirection(ball) {
    if (!(ball.contactFor > 0)) return { tx: -1, ty: 0 };
    const ahead = P.ballR;
    const dx = -ahead;
    const here = groundYAt(ball.x);
    const there = groundYAt(ball.x - ahead);
    let dy = there - here;

    // A spike NARROWER than the look-ahead is invisible to a two-point reading: both ends sit
    // below its top, so "forward" comes out level or even downhill and every push drives the
    // runner into the flank of the thing it is trying to get over. Scanning the span for its
    // crest sees that wall. Only a crest above BOTH ends counts, which is what keeps a descent
    // a descent - on the way down the highest ground in the span is the runner's own footing,
    // and overriding on that would flatten every slope the race gets its speed from.
    let crest = here;
    for (let x = ball.x - COLUMN_PX; x > ball.x - ahead; x -= COLUMN_PX) {
      const y = groundYAt(x);
      if (y < crest) crest = y;
    }
    if (crest < here && crest < there) dy = crest - here;

    const len = Math.hypot(dx, dy) || 1;
    return { tx: dx / len, ty: dy / len };
  }

  /**
   * Gravity's component along the runner's FORWARD direction on the surface it is touching.
   * Negative means the slope is working against it, which is the only case the cling holds.
   */
  function gravityAlongForward(ball, tx, ty) {
    const dir = forwardDirection(ball);
    const sign = dir.tx * tx + dir.ty * ty >= 0 ? 1 : -1;
    return P.gravity * ty * sign;
  }

  function fireImpulse(ball) {
    if (ball.groundedFor > 0 && Math.random() < JUMP_CHANCE) {
      ball.vy -= rand(P.jumpMin, P.jumpMax);
      ball.groundedFor = 0;
      ball.contactFor = 0;
      playSound("jump");
      return;
    }
    // Always leftward. Nobody in this race wants to go back up their own stream.
    const dir = forwardDirection(ball);
    // 0 along the flat, 1 straight up a wall - and squared before it is paid out, see CLIMB_ASSIST.
    const climb = Math.max(0, -dir.ty);
    const push = rand(P.pushMin, P.pushMax) * (1 + CLIMB_ASSIST * climb * climb);
    ball.vx += dir.tx * push;
    ball.vy += dir.ty * push;
  }

  // -----------------------------------------------------------------------------------------
  // Runners
  // -----------------------------------------------------------------------------------------

  function safeCssUrl(url) {
    if (typeof url !== "string") return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return url.replace(/["'()\\\s]/g, "");
  }

  function buildBallElement(racer, lane) {
    const color = racer.color || DEFAULT_COLOR;
    const r = P.ballR;

    const wrap = document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.left = "0";
    wrap.style.top = "0";
    wrap.style.willChange = "transform";

    const disc = document.createElement("div");
    disc.style.position = "absolute";
    disc.style.left = -r + "px";
    disc.style.top = -r + "px";
    disc.style.width = r * 2 + "px";
    disc.style.height = r * 2 + "px";
    disc.style.borderRadius = "50%";
    disc.style.overflow = "hidden";
    disc.style.background = color;
    disc.style.border = "2px solid " + color;
    disc.style.boxShadow = "0 0 0 1px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.5)";
    disc.style.display = "flex";
    disc.style.alignItems = "center";
    disc.style.justifyContent = "center";
    disc.style.fontSize = Math.round(r * 0.9) + "px";
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
    label.style.top = r + 4 + (lane % LABEL_ROWS) * LABEL_ROW_PX + "px";
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

  // Warmed once the page has settled, never at race start: image decode is main-thread work and
  // the race saturates the main thread with a 240Hz fixed-step loop. Measured in Chromium,
  // requesting the avatars when the race began left only 1-2 of 4 decoded three and a half
  // seconds in, so runners spent the opening of every race as blank monograms.
  let avatarsReady = null;

  function preloadAvatars() {
    if (avatarsReady) return avatarsReady;
    const urls = [];
    for (const racer of pool) {
      const url = safeCssUrl(racer.avatarUrl);
      if (url && urls.indexOf(url) === -1) urls.push(url);
    }
    avatarsReady = true;
    for (const url of urls) {
      const img = new Image();
      img.src = url;
    }
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
    node.style.background =
      "linear-gradient(90deg, rgba(248,113,113,0) 0%, #f87171 35%, #fff 50%, #f87171 65%, rgba(248,113,113,0) 100%)";
    node.style.boxShadow = "0 0 12px 4px rgba(248,113,113,.75)";
    return node;
  }

  // -----------------------------------------------------------------------------------------
  // Race-mode layout
  // -----------------------------------------------------------------------------------------

  let inRaceLayout = false;

  /**
   * Widens the chart card out of the page's max-width column and takes the arena's height FROM
   * that width, so the drawn curve keeps the aspect ratio it has at rest. Growing the height
   * alone (what this did first) stretches the plot vertically and changes the shape of the very
   * graph the race is supposed to be run on.
   */
  function enterRaceLayout(done) {
    if (inRaceLayout) {
      done();
      return;
    }

    const cardRect = card.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (!(svgRect.width > 0) || !(svgRect.height > 0)) {
      done();
      return;
    }
    inRaceLayout = true;

    // Everything in the card that is not the plot itself: the two axis columns, their gaps and
    // the card's padding. Measured rather than derived from the Tailwind classes, so a change to
    // the chart's markup cannot silently offset the track.
    const chrome = cardRect.width - svgRect.width;
    const aspect = svgRect.width / svgRect.height;

    let svgW = document.documentElement.clientWidth - RACE_GUTTER_PX * 2 - chrome;
    let svgH = svgW / aspect;
    const maxH = window.innerHeight * RACE_MAX_VH;
    if (svgH > maxH) {
      svgH = maxH;
      svgW = svgH * aspect; // give width back, never the ratio
    }
    if (svgW < svgRect.width) {
      svgW = svgRect.width; // never end up narrower than at rest
      svgH = svgW / aspect;
    }

    const cardW = svgW + chrome;
    const parentW = card.parentElement ? card.parentElement.clientWidth : cardW;

    card.style.transition = "width " + EXPAND_MS + "ms ease, margin-left " + EXPAND_MS + "ms ease";
    card.style.maxWidth = "none";
    card.style.width = cardW + "px";
    card.style.marginLeft = Math.round((parentW - cardW) / 2) + "px";
    svg.style.transition = "height " + EXPAND_MS + "ms ease";
    svg.style.height = svgH + "px";

    // The terrain must be sampled from the SETTLED geometry - taking it mid-transition would
    // measure a track that is not the one the runners then race on.
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
    setTimeout(finish, EXPAND_MS + 120); // transitionend never fires if nothing actually changed
  }

  function exitRaceLayout() {
    inRaceLayout = false;
    card.style.transition = "";
    card.style.maxWidth = "";
    card.style.width = "";
    card.style.marginLeft = "";
    svg.style.transition = "";
    svg.style.height = "";
  }

  function lockChart(locked) {
    svg.style.pointerEvents = locked ? "none" : "";
    if (select) select.disabled = locked;
    if (locked && tooltip) tooltip.classList.add("hidden");
  }

  // -----------------------------------------------------------------------------------------
  // Race state machine
  // -----------------------------------------------------------------------------------------

  let running = false;
  let terrain = null;
  let terrainKey = null;
  let balls = [];
  let results = [];
  let raceT = 0;
  let rayEl = null;
  let raySeen = false;
  let rafId = 0;
  let lastFrameAt = 0;

  function startRace() {
    const rect = svg.getBoundingClientRect();
    const key = Math.round(rect.width) + "x" + Math.round(rect.height);
    // The track only depends on the chart's geometry, which cannot change between races here -
    // the session picker is disabled for the duration - so "race again" reuses the sampling.
    if (!terrain || terrainKey !== key) {
      terrain = sampleTerrain();
      terrainKey = key;
    }
    if (!terrain) {
      lockChart(false);
      exitRaceLayout();
      return;
    }
    P = scaledPhysics(terrain.width);

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
    const startX = terrain.width - P.ballR - 4;
    const startY = P.ballR + 4;

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
        contactFor: 0,
        nx: 0,
        ny: -1,
        nextImpulse: 0,
        stuckTimer: 0,
        stuckX: startX,
        stuckY: startY,
        state: "running",
      });
    });
    if (balls.length === 0) {
      arena.hidden = true;
      lockChart(false);
      exitRaceLayout();
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
    ball.x = P.ballR;
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
          // Progress is measured in BOTH axes, not just along the track. A runner part-way up a
          // spike is barely moving in x by design, so an x-only test called it stuck every two
          // seconds and "rescued" it with a hop that broke its cling and dropped it back to the
          // bottom - the anti-stuck rule was undoing the climb it was there to protect.
          const moved = Math.hypot(ball.x - ball.stuckX, ball.y - ball.stuckY);
          if (moved < P.stuckDx) {
            // Along the same forward direction as a normal push, plus a hop: shoving a wedged
            // runner sideways into whatever wedged it just repeats the wedge.
            const dir = forwardDirection(ball);
            ball.vx += dir.tx * P.stuckPush;
            ball.vy += dir.ty * P.stuckPush - P.stuckJump;
            ball.groundedFor = 0;
            ball.contactFor = 0;
            playSound("jump");
          }
          ball.stuckTimer = 0;
          ball.stuckX = ball.x;
          ball.stuckY = ball.y;
        }

        stepBall(ball, terrain, step);

        // Safety net for the one thing segment collision can still miss - a runner that somehow
        // ends up underneath the ground is lifted back onto it rather than falling forever.
        const ci = Math.max(0, Math.min(terrain.points.length - 1, Math.round(ball.x / COLUMN_PX)));
        if (ball.y > terrain.points[ci].y + P.ballR * 2) {
          ball.y = terrain.points[ci].y - P.ballR;
          ball.vy = 0;
        }

        // Reaching the left edge only counts while the runner is actually inside the arena - the
        // other half of the sky-wall rule in stepBall(). A runner still up in the sky bounces off
        // the wall instead of finishing, and claims its place on the way back down.
        if (ball.x <= P.ballR && ball.y + P.ballR >= 0) {
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
          if (ball.x + P.ballR >= rayX) destroyBall(ball);
        }
      }
    }
  }

  function draw() {
    for (const ball of balls) {
      if (ball.state === "destroyed") continue;
      // "Stops being drawn above the top edge" - the simulation carries on regardless, so a
      // runner that comes back down rejoins the race exactly where the physics put it.
      const hidden = ball.y + P.ballR < 0;
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
    terrain = null;
    terrainKey = null;
    lockChart(false);
    exitRaceLayout();
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
    enterRaceLayout(startRace);
  });

  const closeBtn = $("stream-race-results-close");
  const okBtn = $("stream-race-ok");
  const againBtn = $("stream-race-again");
  if (closeBtn) closeBtn.addEventListener("click", closeRace);
  if (okBtn) okBtn.addEventListener("click", closeRace);
  if (againBtn) againBtn.addEventListener("click", raceAgain);

  // Fetched and decoded while the page is idle, long before anyone presses the button - so the
  // click itself never waits on the network.
  if (window.requestIdleCallback) window.requestIdleCallback(() => preloadAvatars(), { timeout: 3000 });
  else setTimeout(preloadAvatars, 1200);
})();
