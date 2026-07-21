// Pure, I/O-free Pong physics - server-only, driven by realtime/
// quickMatchManager.js's tick loop (unlike the 3 turn-based games, this
// engine's "move" is really applyInput (paddle intent) + step (physics tick)
// - see that manager's tick-mode branch). Never shipped to the browser;
// public/js/games/pong.js hardcodes the same COURT_WIDTH/HEIGHT/etc.
// constants purely for rendering scale, same as this repo's other client
// scripts hardcoding a server-side shape they never import (no bundler here).
"use strict";

const COURT_WIDTH = 400;
const COURT_HEIGHT = 300;
const PADDLE_WIDTH = 10;
const PADDLE_HEIGHT = 60;
const PADDLE_SPEED = 300; // units/sec
const BALL_RADIUS = 6;
const BASE_BALL_SPEED = 200; // units/sec
// Ball "accelerates over time" per the feature request - interpreted as a
// per-point ramp (not per-hit), so a single long rally doesn't itself speed
// the ball up, but the match as a whole gets faster-paced as it progresses.
const SPEED_INCREMENT_PER_POINT = 20;
const MAX_BALL_SPEED = 500;
const TARGET_SCORE = 7;
const MAX_BOUNCE_ANGLE = Math.PI / 3; // 60 degrees at the paddle's extreme edge
const LAUNCH_ANGLE_RANGE = Math.PI / 6; // ±30 degrees off horizontal

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomLaunchAngle() {
  return (Math.random() * 2 - 1) * LAUNCH_ANGLE_RANGE;
}

function freshBall(speed) {
  const dirSign = Math.random() < 0.5 ? -1 : 1;
  const angle = randomLaunchAngle();
  return {
    x: COURT_WIDTH / 2,
    y: COURT_HEIGHT / 2,
    vx: dirSign * speed * Math.cos(angle),
    vy: speed * Math.sin(angle),
  };
}

function createInitialState() {
  return {
    paddles: [
      { y: COURT_HEIGHT / 2, dir: 0 },
      { y: COURT_HEIGHT / 2, dir: 0 },
    ],
    ball: freshBall(BASE_BALL_SPEED),
    scores: [0, 0],
    rallySpeed: BASE_BALL_SPEED,
    winnerSeat: null,
  };
}

// input: { dir: -1 | 0 | 1 } - paddle movement intent only, applied on the
// next step() tick. Any other value is treated as "stop".
function applyInput(state, seat, input) {
  const dir = input && input.dir;
  state.paddles[seat].dir = dir === -1 || dir === 1 ? dir : 0;
}

function bouncePaddle(ball, paddle, newDirSign, speed) {
  const offset = clamp((ball.y - paddle.y) / (PADDLE_HEIGHT / 2), -1, 1);
  const angle = offset * MAX_BOUNCE_ANGLE;
  ball.vx = newDirSign * speed * Math.cos(angle);
  ball.vy = speed * Math.sin(angle);
  // Nudge the ball just outside the paddle so it can't re-collide next tick.
  ball.x = newDirSign === 1 ? PADDLE_WIDTH + BALL_RADIUS + 0.5 : COURT_WIDTH - PADDLE_WIDTH - BALL_RADIUS - 0.5;
}

function scorePoint(state, seat) {
  state.scores[seat] += 1;
  if (state.scores[seat] >= TARGET_SCORE) {
    state.winnerSeat = seat;
    return;
  }
  state.rallySpeed = Math.min(state.rallySpeed + SPEED_INCREMENT_PER_POINT, MAX_BALL_SPEED);
  state.ball = freshBall(state.rallySpeed);
  for (const paddle of state.paddles) paddle.y = COURT_HEIGHT / 2;
}

// dtMs is clamped to 100ms so a stalled/paused tick (a slow event loop, or
// resuming a tick timer after realtime/quickMatchManager.js pauses it during
// a disconnect) can't move the ball or a paddle in one giant leap.
function step(state, dtMs) {
  if (state.winnerSeat != null) return;
  const dt = Math.min(dtMs, 100) / 1000;

  for (const paddle of state.paddles) {
    paddle.y = clamp(paddle.y + paddle.dir * PADDLE_SPEED * dt, PADDLE_HEIGHT / 2, COURT_HEIGHT - PADDLE_HEIGHT / 2);
  }

  const ball = state.ball;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y - BALL_RADIUS < 0) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy);
  } else if (ball.y + BALL_RADIUS > COURT_HEIGHT) {
    ball.y = COURT_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy);
  }

  const p0 = state.paddles[0];
  const p1 = state.paddles[1];
  if (ball.vx < 0 && ball.x - BALL_RADIUS <= PADDLE_WIDTH && ball.x - BALL_RADIUS >= -BALL_RADIUS && Math.abs(ball.y - p0.y) <= PADDLE_HEIGHT / 2) {
    bouncePaddle(ball, p0, 1, state.rallySpeed);
  } else if (
    ball.vx > 0 &&
    ball.x + BALL_RADIUS >= COURT_WIDTH - PADDLE_WIDTH &&
    ball.x + BALL_RADIUS <= COURT_WIDTH + BALL_RADIUS &&
    Math.abs(ball.y - p1.y) <= PADDLE_HEIGHT / 2
  ) {
    bouncePaddle(ball, p1, -1, state.rallySpeed);
  }

  if (ball.x < -BALL_RADIUS * 2) scorePoint(state, 1);
  else if (ball.x > COURT_WIDTH + BALL_RADIUS * 2) scorePoint(state, 0);
}

function checkGameOver(state) {
  return state.winnerSeat != null ? { winnerSeat: state.winnerSeat } : null;
}

// No hidden info in Pong - both seats see the full court. Returned as-is;
// realtime/quickMatchManager.js sends it through JSON.stringify per tick
// anyway, which already snapshots it independent of this object's identity.
function serializeForSeat(state) {
  return state;
}

module.exports = {
  COURT_WIDTH,
  COURT_HEIGHT,
  PADDLE_WIDTH,
  PADDLE_HEIGHT,
  BALL_RADIUS,
  BASE_BALL_SPEED,
  MAX_BALL_SPEED,
  TARGET_SCORE,
  createInitialState,
  applyInput,
  step,
  checkGameOver,
  serializeForSeat,
};
