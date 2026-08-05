// Pure, I/O-free Pipe Dodger physics - no canvas, no sound, no clouds or
// particles, so it runs under node:test and server-side (lib/gameReplay/
// pipe-dodger.js) off the same source the browser uses. Same placement rule as
// minesweeperEngine.js: no bundler here, so a file both sides need lives under
// public/js/games/engines/ and exports itself as a CommonJS module OR a
// browser global.
//
// The interface deliberately mirrors the tick-mode engine contract the
// multiplayer games already use (realtime/quickMatchManager.js:57-64,
// lib/pongEngine.js), so this codebase has ONE engine idiom:
//
//   createState(rng)
//   applyInput(state, "flap")
//   step(state) -> { scored, dead }
//
// FIXED TIMESTEP. The original loop integrated with whatever delta the browser
// happened to deliver, which is not reproducible - two players on 60Hz and
// 144Hz screens got measurably different physics, and the server could not
// reproduce either. Every step is now exactly FIXED_DT_MS, with the caller
// keeping an accumulator. That IS a small change to game feel (gravity is
// integrated more finely), made deliberately.
//
// Determinism note: everything below is + - * / and Math.min/max, all exactly
// specified by IEEE-754. Nothing transcendental - Math.pow/sin/exp are not
// correctly-rounded in ECMAScript and may differ in the last ULP between the
// server's V8 and a player's Firefox or Safari, which would silently desync a
// replay and cost an honest player their score. The bird's visual rotation and
// the clouds keep using such maths, which is fine: they live in the client.
"use strict";

const WIDTH = 360;
const HEIGHT = 600;
const GROUND_H = 70;

const BIRD_X = 110;
const BIRD_W = 44;
const BIRD_H = 40;
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
const SPAWN_SPACING = 235; // px between pipe pairs
const RAMP_POINTS_TO_MAX = 15;

// 125Hz. Fine enough that the fixed step is imperceptible, coarse enough that
// a long run stays well inside the replay budget.
const FIXED_DT_MS = 8;
const FIXED_DT_S = FIXED_DT_MS / 1000;

function difficultyFor(currentScore) {
  const t = Math.min(1, currentScore / RAMP_POINTS_TO_MAX);
  return {
    speed: SPEED_START + (SPEED_MAX - SPEED_START) * t,
    gap: GAP_START - (GAP_START - GAP_MIN) * t,
  };
}

function createState(rng) {
  const d = difficultyFor(0);
  return {
    rng,
    birdY: HEIGHT / 2,
    birdVy: 0,
    pipes: [],
    distSinceSpawn: 0,
    score: 0,
    speed: d.speed,
    gap: d.gap,
    dead: false,
  };
}

function applyInput(state, input) {
  // Idempotent on purpose: two flaps inside one step set the same velocity, so
  // the client (which coalesces them into one queued flap) and the server
  // (which applies each recorded event) cannot disagree.
  if (input === "flap" && !state.dead) state.birdVy = FLAP_VELOCITY;
}

function spawnPipe(state) {
  const margin = 40;
  const usableH = HEIGHT - GROUND_H - margin * 2 - state.gap;
  const gapTop = margin + state.rng() * Math.max(0, usableH);
  state.pipes.push({ x: WIDTH, gapTop, gapBottom: gapTop + state.gap, passed: false });
}

function birdHitbox(state) {
  return {
    left: BIRD_X - BIRD_W / 2 + BIRD_HIT_INSET_X,
    right: BIRD_X + BIRD_W / 2 - BIRD_HIT_INSET_X,
    top: state.birdY - BIRD_H / 2 + BIRD_HIT_INSET_Y,
    bottom: state.birdY + BIRD_H / 2 - BIRD_HIT_INSET_Y,
  };
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function checkCollision(state) {
  const hb = birdHitbox(state);
  if (hb.top <= 0 || hb.bottom >= HEIGHT - GROUND_H) return true;
  for (const pipe of state.pipes) {
    if (pipe.x + PIPE_W < hb.left || pipe.x > hb.right) continue;
    const top = { left: pipe.x, right: pipe.x + PIPE_W, top: 0, bottom: pipe.gapTop };
    const bottom = { left: pipe.x, right: pipe.x + PIPE_W, top: pipe.gapBottom, bottom: HEIGHT - GROUND_H };
    if (rectsOverlap(hb, top) || rectsOverlap(hb, bottom)) return true;
  }
  return false;
}

// Exactly one FIXED_DT_MS of simulation.
function step(state) {
  if (state.dead) return { scored: 0, dead: true };

  const d = difficultyFor(state.score);
  state.speed = d.speed;
  state.gap = d.gap;

  state.birdVy = Math.min(MAX_FALL_SPEED, state.birdVy + GRAVITY * FIXED_DT_S);
  state.birdY += state.birdVy * FIXED_DT_S;

  state.distSinceSpawn += state.speed * FIXED_DT_S;
  if (state.distSinceSpawn >= SPAWN_SPACING) {
    state.distSinceSpawn -= SPAWN_SPACING;
    spawnPipe(state);
  }

  let scored = 0;
  for (const pipe of state.pipes) {
    pipe.x -= state.speed * FIXED_DT_S;
    if (!pipe.passed && pipe.x + PIPE_W < BIRD_X - BIRD_W / 2) {
      pipe.passed = true;
      state.score++;
      scored++;
    }
  }
  state.pipes = state.pipes.filter((pipe) => pipe.x > -PIPE_W - 5);

  if (checkCollision(state)) state.dead = true;
  return { scored, dead: state.dead };
}

const api = {
  WIDTH,
  HEIGHT,
  GROUND_H,
  BIRD_X,
  BIRD_W,
  BIRD_H,
  PIPE_W,
  FIXED_DT_MS,
  SPAWN_SPACING,
  SPEED_MAX,
  difficultyFor,
  createState,
  applyInput,
  step,
  birdHitbox,
  checkCollision,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.PipeDodgerEngine = api;
}
