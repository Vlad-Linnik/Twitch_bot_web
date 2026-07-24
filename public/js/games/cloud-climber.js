// /games/cloud-climber - a fully client-side endless-jumper (Doodle-Jump-style)
// game. The player character ("Dudo") is a real sprite pair
// (public/img/games/cloud-climber/), swapped idle/shooting per drawPlayer()
// below; everything else (platforms, monsters, boosts) is still drawn with
// plain canvas primitives on purpose, same "ship the mechanics first"
// approach as falling-blocks' block rendering - can be layered in later
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
  const PLAYER_NAME = (board.dataset.playerName && board.dataset.playerName.trim()) || board.dataset.anonymousLabel || "Player";

  const PLAYER_W = 40;
  const PLAYER_H = 44;
  // Hitbox narrower than the drawn body so near-miss grazes off a platform's
  // edge still count as a landing - matches pipe-dodger's forgiving-hitbox approach.
  const PLAYER_HIT_HALF_W = PLAYER_W / 2 - 6;

  const GRAVITY = 1700; // px/s^2
  const MAX_FALL_SPEED = 900; // px/s
  const JUMP_VELOCITY = -820; // normal/moving/breaking platform bounce
  const SPRING_VELOCITY = -1350; // spring pickup, the biggest plain bounce
  const JETPACK_SPEED = -900; // constant climb speed while a jetpack is active
  const JETPACK_DURATION_MS = 3600;

  const STEER_GAIN = 6; // how eagerly the player chases a drag/touch target
  const ACCEL = 2200; // px/s^2, keyboard control
  const FRICTION_DECEL = 2600; // px/s^2, keyboard control with no key held
  const MAX_H_SPEED = 380; // px/s
  const FACE_DEADZONE = 20; // px/s - below this, keep the last facing direction instead of flickering

  const PLATFORM_W = 68;
  const PLATFORM_H = 16;
  // Visual-only sprite width target (the hitbox, PLAYER_W/PLAYER_H above,
  // stays untouched so jump/landing/collision math doesn't shift). Height is
  // derived per-pose from the sprite's own natural aspect ratio (see
  // drawPlayer()) rather than a fixed target, so neither pose is stretched.
  const PLAYER_SPRITE_TARGET_W = PLATFORM_W * 1.5;
  const MIN_GAP = 50;
  // The gap ceiling itself climbs with height - closer/denser near the start,
  // gradually sparser higher up - but MAX_GAP_LATE is kept safely under a
  // plain JUMP_VELOCITY bounce's max reach (~198px) so every gap this ever
  // produces stays climbable, no matter how sparse the game gets.
  const MAX_GAP_EARLY = 90;
  const MAX_GAP_LATE = 165;
  const SPARSITY_RAMP_DISTANCE = 20000; // px of climb for the gap ceiling to reach MAX_GAP_LATE - slow on purpose
  const RAMP_WORLD_DISTANCE = 13000; // px of climb to reach max difficulty (bounce-type mix, monster/moving density within their unlocked range)
  const SCROLL_THRESHOLD = HEIGHT * 0.42;
  const BREAK_FADE_MS = 320;
  const MOVING_SPEED_MIN = 55;
  const MOVING_SPEED_MAX = 130;

  // A "breaking" platform always comes back: it fades out, goes quiet for
  // BREAKING_RESPAWN_DELAY_MS (invisible, non-collidable), then reappears in
  // the same spot, fresh and landable again - repeats indefinitely.
  const BREAKING_RESPAWN_DELAY_MS = 3000;

  const SPRING_CHANCE = 0.07;
  const JETPACK_CHANCE = 0.018;

  // Height-gated feature unlocks, each a smoothstep ramp (0 before the start
  // edge, gradually up to 1 by the end edge) rather than a hard cliff - see
  // smoothstep() below.
  const MOVING_PLATFORM_GATE_START = 6000;
  const MOVING_PLATFORM_GATE_END = 9000;
  const BROKEN_PLATFORM_GATE_START = 800;
  const BROKEN_PLATFORM_GATE_END = 3000;
  const MONSTER_GATE_START = 1700;
  const MONSTER_GATE_END = 4300;
  const MONSTER_MOVE_GATE_START = 4000;
  const MONSTER_MOVE_GATE_END = 8000;
  const BIG_MONSTER_GATE_START = 8700;
  const BIG_MONSTER_GATE_END = 14000;
  const BIG_MONSTER_MAX_CHANCE = 0.5; // once fully unlocked, at most half of spawns are the big variant
  const BIG_MONSTER_SCALE = 1.6;

  // Bumped up from 34x30 per the user's "easier to hit" request - the small
  // (non-"big") monster is now noticeably bigger as a bullet target. The big
  // variant (BIG_MONSTER_SCALE below) grows proportionally with it.
  const MONSTER_W = 44;
  const MONSTER_H = 40;
  // Low on purpose - combined with the "at most one alive at a time" cap in
  // maybeSpawnMonster(), monsters should be a rare, occasional threat, not a
  // constant one.
  const MONSTER_CHANCE_MIN = 0.02;
  const MONSTER_CHANCE_MAX = 0.10;
  const MONSTER_KILL_BONUS = 25;

  const BULLET_SPEED = 900; // px/s, world-space upward travel
  const SHOOT_COOLDOWN_MS = 260;

  // --- Black hole hazard -------------------------------------------------------
  // A rare, stationary environmental hazard (distinct from monsters): touching
  // it pulls the player in with a shrink/spin animation and always ends the
  // run, regardless of jetpack invulnerability - a black hole isn't something
  // you fly past. Gated in a bit after monsters start appearing, single
  // instance alive at a time like monsters.
  const BLACKHOLE_R = 24;
  const BLACKHOLE_GATE_START = 3200;
  const BLACKHOLE_GATE_END = 6500;
  const BLACKHOLE_CHANCE_MIN = 0.008;
  const BLACKHOLE_CHANCE_MAX = 0.03;
  const SUCK_ANIM_MS = 700;
  // Minimum center-to-center distance a hole is allowed from the platform
  // being climbed FROM and the one being climbed TO for this gap - a bare
  // platform-radius + hole-kill-radius sum is ~74px (34 + 40), this adds a
  // real buffer on top so an imprecise landing doesn't brush the hole. Found
  // by the user hitting a real case where a hole spawned close enough to the
  // only reachable platform that dodging it wasn't actually possible -
  // placement is now rejection-sampled against both platforms instead of
  // picking a fully independent random x.
  const BLACKHOLE_MIN_PLATFORM_CLEARANCE = 100;
  const BLACKHOLE_PLACEMENT_ATTEMPTS = 8;
  // A guaranteed extra landing spot placed on whichever side has more room
  // once a hole does spawn - a real platform to aim for while routing
  // around it, not just open-air drift timing.
  const BLACKHOLE_ESCAPE_JITTER = 20;

  // --- Death animation ---------------------------------------------------------
  // A brief tumble (spin + continued fall) before gameOver() actually fires,
  // triggered by either a monster collision or falling off the bottom of the
  // screen ("врезается в монстра или просто сам падает вниз") - so the death
  // isn't an instant cut to the overlay.
  const DEATH_ANIM_MS = 650;

  // --- Death markers -------------------------------------------------------
  // Two sources, drawn the same way (drawDeathMarks() below): this browser's
  // own past deaths (localStorage only, never sent anywhere) and other
  // players' best-run death spots (server, paginated - see
  // routes/games.js's /games/cloud-climber/death-marks.json).
  const DEATH_MARKS_KEY = "cloudClimberDeathMarks";
  const OWN_DEATH_MARKS_MAX = 40; // cap so localStorage/the mark list don't grow unbounded across many sessions
  const OTHER_MARKS_PAGE_SIZE = 20;
  // Fetch the next page once the player's own climb gets within this many px
  // of the last-loaded mark's climb, rather than waiting until they've
  // exactly reached/passed it - avoids a visible pop-in right at the edge.
  const OTHER_MARKS_PREFETCH_MARGIN = 1500;
  const DEATH_MARKS_URL = "/games/cloud-climber/death-marks.json";
  // Died-too-early runs (right off the guaranteed starting platform) aren't
  // worth marking - not a real "attempt".
  const MIN_MARK_CLIMB = 60;

  // Score gain multiplier applied to the whole score formula (climb-based
  // score + monster-kill bonus together, see the score line in update()) -
  // 8x per the user's request, kept as a single constant so climb and kill
  // bonus stay in the same proportion to each other as before.
  const SCORE_MULTIPLIER = 8;

  // --- Sprites ---------------------------------------------------------------
  // Player character ("Dudo"): a normal idle pose and a shooting pose whose
  // spout points straight up, matching the upward-shooting mechanic below -
  // swapped in briefly (SHOOT_ANIM_MS) whenever the player fires.
  const SPRITE_BASE = "/img/games/cloud-climber/";
  const playerImg = new Image();
  playerImg.src = SPRITE_BASE + "dudo.png";
  const playerShootImg = new Image();
  playerShootImg.src = SPRITE_BASE + "dudo_shoot.png";
  const SHOOT_ANIM_MS = 180;

  // --- Sound ---------------------------------------------------------------
  // Same convention as pipe-dodger.js: cloneNode() per play so overlapping
  // triggers (e.g. rapid-fire shooting) don't cut each other off, master
  // volume from the shared window.gameVolume slider (gameVolume.js,
  // included on the page before this script).
  const SOUND_BASE = "/sounds/games/cloud-climber/";
  const SOUNDS = {
    land: new Audio(SOUND_BASE + "land.wav"),
    shatter: new Audio(SOUND_BASE + "shatter.wav"),
    shoot: new Audio(SOUND_BASE + "shoot.wav"),
    monster: new Audio(SOUND_BASE + "monster.wav"),
    jetpack: new Audio(SOUND_BASE + "jetpack.wav"),
    spring: new Audio(SOUND_BASE + "spring.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

  function playSound(name, opts) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      const master = window.gameVolume ? window.gameVolume.get() : 1;
      node.volume = (opts && opts.volume != null ? opts.volume : base.volume) * master;
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

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

  function loadOwnDeathMarks() {
    try {
      const raw = localStorage.getItem(DEATH_MARKS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((m) => m && typeof m.climb === "number" && typeof m.name === "string")
        : [];
    } catch (_) {
      return [];
    }
  }

  function saveOwnDeathMarks() {
    try {
      localStorage.setItem(DEATH_MARKS_KEY, JSON.stringify(ownDeathMarks));
    } catch (_) {
      /* private mode etc. - marks just won't persist across sessions */
    }
  }

  // Records where THIS death happened (localStorage only) and returns the
  // climb value, so gameOver() can also send it to the server as the score
  // submission's deathClimb - the one place both the local mark and the
  // server-side "best run" metadata come from the same number.
  function recordOwnDeathMark() {
    const climb = Math.max(0, Math.floor(-camera.y));
    if (climb < MIN_MARK_CLIMB) return climb;
    ownDeathMarks.push({ climb, name: PLAYER_NAME });
    if (ownDeathMarks.length > OWN_DEATH_MARKS_MAX) {
      ownDeathMarks = ownDeathMarks.slice(ownDeathMarks.length - OWN_DEATH_MARKS_MAX);
    }
    saveOwnDeathMarks();
    return climb;
  }

  // Pages through other players' best-run death climbs, 20 at a time,
  // strictly increasing - see the server route's own comment for why. Safe
  // to call opportunistically (update() calls it once per frame the player's
  // climb nears the last-loaded batch); otherMarksLoading/Exhausted make
  // repeat calls a no-op while a fetch is in flight or there's nothing left.
  function fetchMoreDeathMarks() {
    if (otherMarksLoading || otherMarksExhausted) return;
    otherMarksLoading = true;
    fetch(DEATH_MARKS_URL + "?after=" + otherMarksCursor)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || !data.ok || !Array.isArray(data.marks)) return;
        for (const m of data.marks) {
          if (m && typeof m.climb === "number" && typeof m.name === "string") otherMarks.push(m);
        }
        if (data.marks.length < OTHER_MARKS_PAGE_SIZE) {
          otherMarksExhausted = true;
        } else {
          otherMarksCursor = data.marks[data.marks.length - 1].climb;
        }
      })
      .catch(() => {})
      .finally(() => {
        otherMarksLoading = false;
      });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // 0 before edgeStart, an S-curve ramp up to 1 by edgeEnd, 1 after - used to
  // unlock a mechanic gradually starting at a given climb height instead of
  // flipping it on at a hard cliff.
  function smoothstep(edgeStart, edgeEnd, x) {
    if (edgeEnd <= edgeStart) return x >= edgeEnd ? 1 : 0;
    const tt = clamp((x - edgeStart) / (edgeEnd - edgeStart), 0, 1);
    return tt * tt * (3 - 2 * tt);
  }

  // --- Game state ------------------------------------------------------------

  let player; // {x, y, vx, vy}
  let camera; // {y} - screenY = worldY - camera.y; camera.y only ever decreases
  let platforms;
  let highestGeneratedY;
  let lastPlatformX; // x of the most recently generated main-sequence platform - see maybeSpawnBlackHole's placement clearance
  let jetpack; // {active, timeLeft}
  let monsters; // {x, y, baseX, w, h, amplitude, freq, phase, alive}
  let blackholes; // {x, y, r, phase, alive}
  let bullets; // {x, y, vy}
  let worldTime;
  let shootCooldown;
  let shootAnimTimer;
  let dying; // {timer, duration, rotation, spinSpeed} - set while state === "dying"
  let suck; // {timer, duration, startX, startY, holeX, holeY} - set while state === "sucking"
  let score, bonusScore, best;
  let state = "idle"; // idle | running | paused | dying | sucking | over
  let rafId = null;
  let lastTime = 0;
  let particles = [];
  let clouds = [];
  let leftHeld = false;
  let rightHeld = false;
  let steerActive = false;
  let steerTargetX = WIDTH / 2;
  // ctx.scale() factor applied when drawing the sprite: 1 = the art's
  // default (unflipped) direction, which faces left; -1 mirrors it to face
  // right. Persists through zero-vx moments (friction coming to a stop,
  // mid-air with no input) so the character doesn't flicker between poses -
  // only an actual leftward/rightward push updates it, see
  // updateHorizontal()'s FACE_DEADZONE.
  let facingDir = 1;

  // Death markers - persist across restarts within the page load (and, for
  // ownDeathMarks, across sessions via localStorage), so these are NOT reset
  // in reset(), same as `best`.
  let ownDeathMarks = loadOwnDeathMarks(); // {climb, name}
  let otherMarks = []; // {climb, name} - loaded from the server, paginated
  let otherMarksCursor = -1;
  let otherMarksExhausted = false;
  let otherMarksLoading = false;

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

  // "broken" platforms are intentionally NOT one of these choices - they're
  // spawned separately (maybeSpawnBrokenPlatform) as an extra decoy alongside
  // the gap, never in place of a main sequence slot. If they were mixed in
  // here, a "broken" (non-landable) roll could sit between two landable
  // platforms and silently double a gap beyond jump reach - see the
  // reachability note on ensurePlatformsAhead().
  //
  // Moving platforms deliberately overtake normal ones at high altitude
  // (normal shrinks from 0.75 to 0.20, moving grows from 0 to 0.60 once fully
  // unlocked) rather than just becoming somewhat more common.
  function pickPlatformType(t, climb) {
    const movingGate = smoothstep(MOVING_PLATFORM_GATE_START, MOVING_PLATFORM_GATE_END, climb);
    return weightedPick([
      { type: "normal", weight: 0.75 - 0.55 * t },
      { type: "moving", weight: movingGate * (0.15 + 0.45 * t) },
      { type: "breaking", weight: 0.1 + 0.15 * t },
    ]);
  }

  function spawnPlatformAt(y, t, climb) {
    const type = pickPlatformType(t, climb);
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
      gone: false,
      respawnTimer: 0,
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
    return platform;
  }

  // A permanent, non-functional decoy: collidable is false forever (nothing
  // ever flips it back), so it can never be landed/bounced on. Spawned
  // separately from the main platform sequence (see the note on
  // pickPlatformType above) so it never counts toward the jump-reachability
  // guarantee - it's purely a distraction. Destructible two ways, both with
  // a shatter burst: shot by a bullet (updateBullets), or simply touched by
  // the player passing through it (tryBreakBrokenPlatforms) - it never gives
  // a bounce either way, it just stops being in the way afterward.
  function maybeSpawnBrokenPlatform(y, t, climb) {
    const gate = smoothstep(BROKEN_PLATFORM_GATE_START, BROKEN_PLATFORM_GATE_END, climb);
    if (gate <= 0) return;
    const chance = gate * (0.08 + 0.12 * t);
    if (Math.random() >= chance) return;
    const margin = PLATFORM_W / 2 + 6;
    const x = margin + Math.random() * (WIDTH - margin * 2);
    platforms.push({
      x,
      y,
      w: PLATFORM_W,
      h: PLATFORM_H,
      type: "broken",
      alive: true,
      collidable: false,
      breaking: false,
      breakTimer: 0,
      alpha: 1,
      item: null,
      gone: false,
      respawnTimer: 0,
    });
  }

  // Floats in the gap between two platforms (never on top of one) so dodging
  // it is always possible without also having to skip a landing spot.
  // `climb` (world height climbed so far, at this generation position) gates
  // three things in gradually, one after another: monsters existing at all,
  // then monsters drifting instead of sitting still, then a chance of the
  // bigger variant - see the *_GATE_START/_END constants above.
  function maybeSpawnMonster(y, t, climb) {
    if (monsters.some((m) => m.alive)) return; // at most one monster in play at a time
    const gate = smoothstep(MONSTER_GATE_START, MONSTER_GATE_END, climb);
    if (gate <= 0) return;
    const chance = gate * (MONSTER_CHANCE_MIN + (MONSTER_CHANCE_MAX - MONSTER_CHANCE_MIN) * t);
    if (Math.random() >= chance) return;

    const moveGate = smoothstep(MONSTER_MOVE_GATE_START, MONSTER_MOVE_GATE_END, climb);
    const bigGate = smoothstep(BIG_MONSTER_GATE_START, BIG_MONSTER_GATE_END, climb);
    const big = Math.random() < bigGate * BIG_MONSTER_MAX_CHANCE;
    const w = big ? MONSTER_W * BIG_MONSTER_SCALE : MONSTER_W;
    const h = big ? MONSTER_H * BIG_MONSTER_SCALE : MONSTER_H;

    const amplitude = (40 + Math.random() * 60) * moveGate; // 0 amplitude = sits still below the move gate
    const margin = w / 2 + amplitude;
    const baseX = clamp(margin + Math.random() * (WIDTH - margin * 2), w / 2, WIDTH - w / 2);
    // Spawned here, ~200px above the visible screen top (see
    // ensurePlatformsAhead's targetTop lookahead) - so playing the growl
    // right at spawn time means it's heard before the monster scrolls into view.
    playSound("monster");
    monsters.push({
      baseX,
      x: baseX,
      y,
      w,
      h,
      big,
      amplitude,
      freq: 1.2 + Math.random() * 1.2,
      phase: Math.random() * Math.PI * 2,
      alive: true,
    });
  }

  // A plain, always-landable platform at an exact (x, y) - unlike
  // spawnPlatformAt, which always rolls its own random x/type. Used only as
  // maybeSpawnBlackHole's guaranteed "escape route" stepping stone, so it's
  // deliberately never breaking/moving/broken and never carries an item -
  // its only job is being a safe, predictable place to land.
  function spawnEscapePlatform(x, y) {
    platforms.push({
      x,
      y,
      w: PLATFORM_W,
      h: PLATFORM_H,
      type: "normal",
      alive: true,
      collidable: true,
      breaking: false,
      breakTimer: 0,
      alpha: 1,
      item: null,
      gone: false,
      respawnTimer: 0,
    });
  }

  // Same "floats in the gap, never on top of a platform" placement as
  // maybeSpawnMonster, and the same "at most one alive at a time" cap - a
  // second black hole on screen at once would turn a rare hazard into a
  // maze. Deliberately not gated by BROKEN/MONSTER's own gates - it's its
  // own, later-starting ramp.
  //
  // prevX/nextX are the x-positions of the two platforms bounding this gap
  // (the one just climbed from, and the one this gap's spawnPlatformAt call
  // just placed) - the hole's own x is rejection-sampled to stay
  // BLACKHOLE_MIN_PLATFORM_CLEARANCE away from BOTH, since a hole placed
  // fully independently of them could end up right next to (or under) the
  // only platform actually reachable this gap, making it genuinely
  // undodgeable - the bug the user reported. If no candidate clears both
  // within BLACKHOLE_PLACEMENT_ATTEMPTS tries (only possible when the two
  // platforms already sit close to opposite edges), the spawn is skipped
  // outright rather than risking an unsafe placement - it's rare enough that
  // occasionally skipping doesn't meaningfully change how often the hazard
  // shows up.
  // Rejection-samples an x at least BLACKHOLE_MIN_PLATFORM_CLEARANCE from
  // both prevX and nextX, places the hole there plus its escape platform,
  // and returns true - or returns false (spawning nothing) if no candidate
  // clears both within BLACKHOLE_PLACEMENT_ATTEMPTS tries. Split out from
  // maybeSpawnBlackHole so it's a pure, directly-testable placement step
  // with no gate/chance rolls of its own.
  function placeBlackHole(y, prevX, nextX) {
    const margin = BLACKHOLE_R + 10;
    let x = null;
    for (let attempt = 0; attempt < BLACKHOLE_PLACEMENT_ATTEMPTS; attempt++) {
      const candidate = margin + Math.random() * (WIDTH - margin * 2);
      if (
        Math.abs(candidate - prevX) >= BLACKHOLE_MIN_PLATFORM_CLEARANCE &&
        Math.abs(candidate - nextX) >= BLACKHOLE_MIN_PLATFORM_CLEARANCE
      ) {
        x = candidate;
        break;
      }
    }
    if (x === null) return false;
    blackholes.push({ x, y, r: BLACKHOLE_R, phase: Math.random() * Math.PI * 2, alive: true });

    // Escape platform on whichever side of the canvas has more clearance
    // from the hole - always a real stepping stone away from it, not just
    // relying on the main gap platforms happening to be dodge-friendly.
    const escapeMargin = PLATFORM_W / 2 + 6;
    const escapeBase = x < WIDTH / 2 ? WIDTH - escapeMargin : escapeMargin;
    const escapeX = clamp(
      escapeBase + (Math.random() * BLACKHOLE_ESCAPE_JITTER * 2 - BLACKHOLE_ESCAPE_JITTER),
      escapeMargin,
      WIDTH - escapeMargin
    );
    spawnEscapePlatform(escapeX, y);
    return true;
  }

  function maybeSpawnBlackHole(y, t, climb, prevX, nextX) {
    if (blackholes.some((b) => b.alive)) return;
    const gate = smoothstep(BLACKHOLE_GATE_START, BLACKHOLE_GATE_END, climb);
    if (gate <= 0) return;
    const chance = gate * (BLACKHOLE_CHANCE_MIN + (BLACKHOLE_CHANCE_MAX - BLACKHOLE_CHANCE_MIN) * t);
    if (Math.random() >= chance) return;
    placeBlackHole(y, prevX, nextX);
  }

  // The "level is passable" guarantee only concerns platforms you can
  // actually bounce off - every call to spawnPlatformAt() below produces
  // exactly one such platform per gap, so the gap sequence is what the
  // MAX_GAP_LATE/JUMP_VELOCITY reachability math is about. maybeSpawnMonster
  // and maybeSpawnBrokenPlatform add extra, optional obstacles into that same
  // gap without ever replacing or displacing the landable platform - a
  // "broken" (non-landable) platform must never be allowed to eat a gap slot,
  // or two real gaps could stack into one unreachable one.
  function ensurePlatformsAhead() {
    const targetTop = camera.y - 200;
    while (highestGeneratedY > targetTop) {
      const climb = -highestGeneratedY;
      const t = difficultyAt(climb);
      const densityT = clamp(climb / SPARSITY_RAMP_DISTANCE, 0, 1);
      const gapCeiling = MAX_GAP_EARLY + (MAX_GAP_LATE - MAX_GAP_EARLY) * densityT;
      const gap = MIN_GAP + (gapCeiling - MIN_GAP) * t + (Math.random() * 20 - 10);
      const gapMidY = highestGeneratedY - gap / 2;
      const prevX = lastPlatformX;
      highestGeneratedY -= gap;
      const newPlatform = spawnPlatformAt(highestGeneratedY, t, climb);
      lastPlatformX = newPlatform.x;
      maybeSpawnMonster(gapMidY, t, climb);
      maybeSpawnBrokenPlatform(gapMidY, t, climb);
      maybeSpawnBlackHole(gapMidY, t, climb, prevX, newPlatform.x);
    }
  }

  function reset() {
    player = { x: WIDTH / 2, y: HEIGHT - 140, vx: 0, vy: JUMP_VELOCITY * 0.7 };
    camera = { y: 0 };
    jetpack = { active: false, timeLeft: 0 };
    platforms = [];
    monsters = [];
    blackholes = [];
    bullets = [];
    worldTime = 0;
    shootCooldown = 0;
    shootAnimTimer = 0;
    dying = null;
    suck = null;
    score = 0;
    bonusScore = 0;
    particles = [];
    leftHeld = false;
    rightHeld = false;
    steerActive = false;
    facingDir = 1;

    // A guaranteed wide starting platform right under the player.
    highestGeneratedY = HEIGHT - 60;
    lastPlatformX = WIDTH / 2;
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

  function monsterBox(m) {
    return {
      left: m.x - m.w / 2,
      right: m.x + m.w / 2,
      top: m.y - m.h / 2,
      bottom: m.y + m.h / 2,
    };
  }

  function spawnMonsterBurst(m) {
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 3;
      particles.push({
        x: m.x,
        y: m.y - camera.y,
        vx: Math.cos(angle) * sp,
        vy: Math.sin(angle) * sp - 1,
        color: ["#dc2626", "#f87171", "#fecaca", "#7f1d1d"][i % 4],
        size: 2 + Math.random() * 3,
        life: 0,
        maxLife: 350 + Math.random() * 250,
      });
    }
  }

  // Used both when a "breaking" platform finishes its crack animation and
  // vanishes, and when a "broken" decoy gets shot - the moment a platform
  // actually shatters.
  function spawnPlatformShatterBurst(p) {
    playSound("shatter");
    const colors = platformColor(p.type);
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2.5;
      particles.push({
        x: p.x + (Math.random() * p.w - p.w / 2),
        y: p.y - camera.y,
        vx: Math.cos(angle) * sp,
        vy: Math.sin(angle) * sp - 1.5,
        color: i % 2 === 0 ? colors.fill : colors.edge,
        size: 1.5 + Math.random() * 2.5,
        life: 0,
        maxLife: 300 + Math.random() * 250,
      });
    }
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
    const deathClimb = recordOwnDeathMark();
    if (score > best) {
      best = score;
      writeBest(best);
      updateHud();
    }
    submitScore(score, deathClimb);
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
  function submitScore(finalScore, deathClimb) {
    if (!leaderboard || !leaderboard.dataset.submitUrl || finalScore < 1) return;
    const body = { _csrf: leaderboard.dataset.csrf, score: String(finalScore) };
    if (typeof deathClimb === "number") body.deathClimb = String(deathClimb);
    fetch(leaderboard.dataset.submitUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
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
      case "broken":
        return { fill: "#78716c", edge: "#44403c" };
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

      // "broken" platforms show a static full crack (always looked cracked).
      // "breaking" platforms build up to one instead - no crack at all until
      // landed on, growing to full crack well before the fade finishes so it
      // reads as "cracking apart" rather than just fading out. Suppressed
      // entirely while p.gone (mid-respawn-wait) - it must stay fully
      // invisible then, not just have its body alpha at 0.
      if (p.type === "broken" || (p.type === "breaking" && !p.gone)) {
        const crackAlpha = p.type === "broken" ? 1 : Math.min(1, (p.breakTimer / BREAK_FADE_MS) * 1.5);
        ctx.globalAlpha = crackAlpha;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.lineWidth = 1.4;
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

  function drawMonsters() {
    for (const m of monsters) {
      if (!m.alive) continue;
      const screenY = m.y - camera.y;
      if (screenY < -40 || screenY > HEIGHT + 40) continue;
      ctx.save();
      ctx.translate(m.x, screenY);

      const spikes = 8;
      const outerR = m.w / 2;
      const innerR = m.w / 2 * 0.6;
      const squashY = m.h / m.w;
      ctx.fillStyle = m.big ? "#7c2d12" : "#dc2626";
      ctx.beginPath();
      for (let i = 0; i < spikes * 2; i++) {
        const angle = (i / (spikes * 2)) * Math.PI * 2;
        const r = i % 2 === 0 ? outerR : innerR;
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r * squashY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = m.big ? "#431407" : "#7f1d1d";
      ctx.lineWidth = m.big ? 2.2 : 1.5;
      ctx.stroke();

      const eyeScale = m.w / MONSTER_W;
      const eyeOffsetX = 6 * eyeScale;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(-eyeOffsetX, -2 * eyeScale, 4 * eyeScale, 0, Math.PI * 2);
      ctx.arc(eyeOffsetX, -2 * eyeScale, 4 * eyeScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111111";
      ctx.beginPath();
      ctx.arc(-eyeOffsetX, -2 * eyeScale, 1.8 * eyeScale, 0, Math.PI * 2);
      ctx.arc(eyeOffsetX, -2 * eyeScale, 1.8 * eyeScale, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  function drawBlackholes() {
    for (const b of blackholes) {
      if (!b.alive) continue;
      const screenY = b.y - camera.y;
      if (screenY < -60 || screenY > HEIGHT + 60) continue;
      const pulse = 1 + Math.sin(worldTime * 3 + b.phase) * 0.06;
      const r = b.r * pulse;

      ctx.save();
      ctx.translate(b.x, screenY);

      const grad = ctx.createRadialGradient(0, 0, r * 0.15, 0, 0, r);
      grad.addColorStop(0, "#000000");
      grad.addColorStop(0.55, "#1e1b4b");
      grad.addColorStop(1, "rgba(76, 29, 149, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(196, 181, 253, 0.75)";
      ctx.lineWidth = 2;
      const rotation = worldTime * 2.4 + b.phase;
      for (let i = 0; i < 3; i++) {
        const a = rotation + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.72, a, a + 1.6);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  function drawBullets() {
    ctx.fillStyle = "#fde047";
    for (const b of bullets) {
      const screenY = b.y - camera.y;
      if (screenY < -20 || screenY > HEIGHT + 20) continue;
      ctx.beginPath();
      ctx.ellipse(b.x, screenY, 3, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // A mark's climb (px reached before that death) maps to the same world Y
  // for both ownDeathMarks and otherMarks - SCROLL_THRESHOLD approximates
  // where the player actually was when the camera stopped following them
  // (camera.y = player.y - SCROLL_THRESHOLD while climbing), rather than the
  // top-of-screen world Y that -climb alone would give.
  function climbToWorldY(climb) {
    return SCROLL_THRESHOLD - climb;
  }

  function drawOneDeathMark(name, worldY, bgColor, textColor) {
    const screenY = worldY - camera.y;
    if (screenY < -10 || screenY > HEIGHT + 10) return;
    const textW = ctx.measureText(name).width;
    const paddingX = 6;
    const boxRight = WIDTH - 6;
    const boxLeft = boxRight - textW - paddingX * 2;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    roundRectPath(ctx, boxLeft, screenY - 9, boxRight - boxLeft, 18, 5);
    ctx.fill();
    ctx.fillStyle = textColor;
    ctx.fillText(name, boxRight - paddingX, screenY + 1);
  }

  // Other players' marks (gold) drawn first, own marks (purple, matching the
  // site's own accent color) drawn on top so a same-height overlap favors
  // the player's own history being legible.
  function drawDeathMarks() {
    if (!otherMarks.length && !ownDeathMarks.length) return;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "600 11px system-ui, sans-serif";
    for (const mark of otherMarks) {
      drawOneDeathMark(mark.name, climbToWorldY(mark.climb), "rgba(146, 108, 12, 0.7)", "#fde68a");
    }
    for (const mark of ownDeathMarks) {
      drawOneDeathMark(mark.name, climbToWorldY(mark.climb), "rgba(88, 28, 135, 0.7)", "#e9d5ff");
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  // Draws the current Dudo pose centered at the canvas origin - the caller is
  // responsible for translate/rotate/scale, so this is shared by the normal
  // in-air pose (drawPlayer) and the dying/sucking death animations below.
  function drawDudoSprite() {
    // Mirror to face the last horizontal direction moved (facingDir, updated
    // in updateHorizontal()) - composes fine with the caller's own
    // translate/rotate/scale since it's just another scale on top.
    ctx.scale(facingDir, 1);

    const img = shootAnimTimer > 0 ? playerShootImg : playerImg;
    if (img.complete && img.naturalWidth) {
      // Fit the sprite's own aspect ratio into a box as wide as
      // PLAYER_SPRITE_TARGET_W, centered - width-driven rather than
      // height-driven so the taller shooting pose doesn't get squeezed
      // narrower than the idle one, and neither pose is stretched off its
      // natural aspect ratio.
      const drawW = PLAYER_SPRITE_TARGET_W;
      const drawH = drawW * (img.naturalHeight / img.naturalWidth);
      ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    } else {
      ctx.fillStyle = jetpack.active ? "#16a34a" : "#22c55e";
      ctx.beginPath();
      ctx.ellipse(0, 0, PLAYER_W / 2, PLAYER_H / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPlayer() {
    if (state === "sucking") {
      drawSuckAnimation();
      return;
    }

    const screenY = player.y - camera.y;
    ctx.save();
    ctx.translate(player.x, screenY);

    if (state === "dying") {
      // Tumbling out of control - spin instead of the normal squash/stretch,
      // fading out over the animation so it doesn't just hard-cut when
      // gameOver() finally fires.
      ctx.rotate(dying.rotation);
      ctx.globalAlpha = Math.max(0, 1 - dying.timer / dying.duration);
    } else {
      const speedFactor = clamp(Math.abs(player.vy) / 900, 0, 1);
      const stretch = player.vy < 0 ? 1 + speedFactor * 0.18 : 1 - speedFactor * 0.12;
      const squash = 1 / Math.sqrt(stretch);
      ctx.scale(squash, stretch);
    }

    drawDudoSprite();

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Player position/scale is interpolated purely in screen space (captured
  // once at startSuck() time) from where the player was touched to the black
  // hole's center, rather than moving player.x/y themselves - update() does
  // nothing to player state while state === "sucking", so this is the only
  // place the animation exists.
  function drawSuckAnimation() {
    const t = clamp(suck.timer / suck.duration, 0, 1);
    const ease = t * t;
    const sx = suck.startX + (suck.holeX - suck.startX) * ease;
    const sy = suck.startY + (suck.holeY - suck.startY) * ease;
    const scale = Math.max(0.001, 1 - t);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(t * Math.PI * 6);
    ctx.globalAlpha = Math.max(0, 1 - t * 0.85);
    ctx.scale(scale, scale);
    drawDudoSprite();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function draw() {
    drawSky();
    drawPlatforms();
    drawBlackholes();
    drawMonsters();
    drawBullets();
    drawDeathMarks();
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

    if (player.vx > FACE_DEADZONE) facingDir = -1; // moving right -> mirror to face right
    else if (player.vx < -FACE_DEADZONE) facingDir = 1; // moving left -> the art's default direction
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
        playSound("land");
        if (p.item && p.item.type === "spring") {
          player.vy = SPRING_VELOCITY;
          p.item = null;
          playSound("spring");
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

  // "broken" platforms are never collidable (see maybeSpawnBrokenPlatform),
  // so the player always passes straight through one rather than landing on
  // it - but that contact now also shatters it, instead of leaving it as a
  // no-op pass-through. Swept over the frame's vertical travel (prevBottom to
  // currentBottom), same shape as tryLandOn's check, so a fast fall can't
  // tunnel past one without registering the hit. Direction-agnostic on
  // purpose - passing through from below (e.g. after a bounce) shatters it
  // too, not just falling onto it from above.
  function tryBreakBrokenPlatforms(prevBottom, currentBottom) {
    const sweepTop = Math.min(prevBottom, currentBottom) - PLAYER_H;
    const sweepBottom = Math.max(prevBottom, currentBottom);
    for (const p of platforms) {
      if (p.type !== "broken" || !p.alive) continue;
      const left = p.x - p.w / 2;
      const right = p.x + p.w / 2;
      if (player.x + PLAYER_HIT_HALF_W < left || player.x - PLAYER_HIT_HALF_W > right) continue;
      const topY = p.y - p.h / 2;
      const bottomY = p.y + p.h / 2;
      if (sweepBottom >= topY && sweepTop <= bottomY) {
        p.alive = false;
        spawnPlatformShatterBurst(p);
      }
    }
  }

  function shoot() {
    if (state !== "running" || shootCooldown > 0) return;
    shootCooldown = SHOOT_COOLDOWN_MS;
    shootAnimTimer = SHOOT_ANIM_MS;
    playSound("shoot");
    bullets.push({ x: player.x, y: player.y - PLAYER_H / 2 - 4, vy: -BULLET_SPEED });
  }

  function updateBullets(dtS) {
    for (const b of bullets) {
      b.y += b.vy * dtS;
    }
    for (const b of bullets) {
      if (b.dead) continue;
      for (const m of monsters) {
        if (!m.alive) continue;
        const mb = monsterBox(m);
        if (b.x > mb.left && b.x < mb.right && b.y > mb.top && b.y < mb.bottom) {
          m.alive = false;
          b.dead = true;
          bonusScore += MONSTER_KILL_BONUS;
          spawnMonsterBurst(m);
          break;
        }
      }
      if (b.dead) continue;
      // "broken" platforms can't be landed on, but they can be shattered -
      // the one interaction they support. No score bonus - they're a pure
      // distraction to clear out of the way, not a reward pickup.
      for (const p of platforms) {
        if (p.type !== "broken" || !p.alive) continue;
        const left = p.x - p.w / 2;
        const right = p.x + p.w / 2;
        const top = p.y - p.h / 2;
        const bottom = p.y + p.h / 2;
        if (b.x > left && b.x < right && b.y > top && b.y < bottom) {
          p.alive = false;
          b.dead = true;
          spawnPlatformShatterBurst(p);
          break;
        }
      }
    }
    bullets = bullets.filter((b) => !b.dead && b.y - camera.y > -40);
  }

  function updateMonsters(dtS) {
    for (const m of monsters) {
      if (!m.alive) continue;
      m.x = clamp(
        m.baseX + Math.sin(worldTime * m.freq + m.phase) * m.amplitude,
        m.w / 2,
        WIDTH - m.w / 2
      );
    }
    monsters = monsters.filter((m) => m.alive && m.y - camera.y < HEIGHT + 80);
  }

  function checkMonsterCollisions() {
    const box = playerBox();
    for (const m of monsters) {
      if (!m.alive) continue;
      const mb = monsterBox(m);
      if (box.left < mb.right && box.right > mb.left && box.top < mb.bottom && box.bottom > mb.top) {
        startDying("monster");
        return;
      }
    }
  }

  // Circular hit test (rather than the AABB the other collision checks use)
  // since a black hole reads as a circular hazard - a corner-of-the-box touch
  // shouldn't count. Checked unconditionally, unlike checkMonsterCollisions -
  // jetpack invulnerability deliberately does not apply here, a black hole
  // isn't something you fly past.
  function checkBlackHoleCollisions() {
    for (const b of blackholes) {
      if (!b.alive) continue;
      const dx = player.x - b.x;
      const dy = player.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < b.r + Math.min(PLAYER_W, PLAYER_H) / 2 - 4) {
        startSuck(b);
        return;
      }
    }
  }

  // --- Death / suck-in animations -----------------------------------------

  function startDying(reason) {
    if (state !== "running") return;
    state = "dying";
    dying = {
      timer: 0,
      duration: DEATH_ANIM_MS,
      rotation: 0,
      spinSpeed: (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3),
    };
    // A little upward pop on a monster hit, so it reads as an impact rather
    // than just continuing to fall exactly as before.
    if (reason === "monster") {
      player.vy = Math.min(player.vy, -260);
    }
  }

  function updateDying(delta) {
    const dtS = delta / 1000;
    dying.timer += delta;
    dying.rotation += dying.spinSpeed * dtS;
    player.vy = Math.min(MAX_FALL_SPEED, player.vy + GRAVITY * dtS);
    player.y += player.vy * dtS;
    updateParticles(delta);
    if (dying.timer >= dying.duration) gameOver();
  }

  function startSuck(hole) {
    if (state !== "running") return;
    state = "sucking";
    suck = {
      timer: 0,
      duration: SUCK_ANIM_MS,
      startX: player.x,
      startY: player.y - camera.y,
      holeX: hole.x,
      holeY: hole.y - camera.y,
    };
  }

  function updateSuck(delta) {
    suck.timer += delta;
    updateParticles(delta);
    if (suck.timer >= suck.duration) {
      // player.x/y were never touched during the suck animation (it's drawn
      // purely from suck's own screen-space interpolation) - snap them to the
      // hole's position now so gameOver()'s spawnDeathBurst() bursts at the
      // hole instead of back at the original touch point. camera.y is
      // unchanged since the trigger (frozen while state !== "running").
      player.x = suck.holeX;
      player.y = suck.holeY + camera.y;
      gameOver();
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
        playSound("jetpack");
        return;
      }
    }
  }

  function update(delta) {
    const dtS = delta / 1000;

    worldTime += dtS;
    if (shootCooldown > 0) shootCooldown -= delta;
    if (shootAnimTimer > 0) shootAnimTimer -= delta;

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
    tryBreakBrokenPlatforms(prevBottom, currentBottom);
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
      if (p.type === "breaking") {
        if (p.breaking) {
          p.breakTimer += delta;
          p.alpha = Math.max(0, 1 - p.breakTimer / BREAK_FADE_MS);
          if (p.breakTimer >= BREAK_FADE_MS) {
            p.breaking = false;
            spawnPlatformShatterBurst(p);
            // Always comes back - goes quiet (invisible, non-collidable)
            // instead of vanishing for good, until the delay elapses.
            p.gone = true;
            p.respawnTimer = 0;
          }
        } else if (p.gone) {
          p.respawnTimer += delta;
          if (p.respawnTimer >= BREAKING_RESPAWN_DELAY_MS) {
            p.gone = false;
            p.collidable = true;
            p.alpha = 1;
            p.breakTimer = 0;
          }
        }
      }
    }

    const desiredCameraY = player.y - SCROLL_THRESHOLD;
    camera.y = Math.min(camera.y, desiredCameraY);

    score = (Math.max(0, Math.floor(-camera.y / 10)) + bonusScore) * SCORE_MULTIPLIER;

    const climb = Math.max(0, Math.floor(-camera.y));
    if (climb > otherMarksCursor - OTHER_MARKS_PREFETCH_MARGIN) fetchMoreDeathMarks();

    ensurePlatformsAhead();
    platforms = platforms.filter((p) => p.alive && p.y - camera.y < HEIGHT + 60);
    blackholes = blackholes.filter((b) => b.alive && b.y - camera.y < HEIGHT + 80);

    updateMonsters(dtS);
    updateBullets(dtS);
    if (!jetpack.active) checkMonsterCollisions();
    if (state === "running") checkBlackHoleCollisions();

    updateParticles(delta);
    updateHud();

    // Triggers the fall-tumble animation as the player crosses the visible
    // bottom edge (still mostly on screen, so the tumble is actually seen)
    // rather than waiting until they're a full PLAYER_H past it.
    if (state === "running" && player.y - camera.y > HEIGHT) {
      startDying("fall");
    }
  }

  function loop(time) {
    rafId = requestAnimationFrame(loop);
    const delta = Math.min(48, time - lastTime);
    lastTime = time;
    if (state === "running") update(delta);
    else if (state === "dying") updateDying(delta);
    else if (state === "sucking") updateSuck(delta);
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
    } else if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") {
      event.preventDefault();
      shoot();
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

  const shootBtn = document.getElementById("cc-shoot-btn");
  if (shootBtn) {
    shootBtn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      shoot();
    });
  }

  // --- Boot --------------------------------------------------------------------

  best = readBest();
  fetchMoreDeathMarks();
  reset();
  draw();
  showOverlay("start");
})();
