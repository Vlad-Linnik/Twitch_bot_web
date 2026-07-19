// Chess-clock-style time budget bookkeeping for multiplayer Durak. Pure given
// an injected `now` (only realtime/durakRoomManager.js ever calls Date.now())
// so this stays unit-testable the same way durakEngine.js is - see
// tests/durakClock.test.js. Deliberately knows nothing about *whose* clock
// should be running right now; that's durakEngine.js's runningSeats(state),
// derived from game rules. This module only knows how to drain and query
// per-seat millisecond budgets given whichever seats the caller says are
// currently running.
"use strict";

const TOTAL_MS_PER_PLAYER = 5 * 60 * 1000;

function createClocks(playerCount, totalMs = TOTAL_MS_PER_PLAYER) {
  return {
    remainingMs: new Array(playerCount).fill(totalMs),
    runningSeats: [],
    lastTick: null,
  };
}

// Applies elapsed wall-clock time (now - lastTick) to every seat that was
// running since the last tick, floors each at zero, then adopts
// `newRunningSeats` as what's running going forward. Mutates and returns
// `clocks` (same in-place-update convention as durakEngine.js's apply*
// functions operating on `state`) - the caller (durakRoomManager.js) owns the
// single `room.clocks` object across a game's lifetime.
function tick(clocks, now, newRunningSeats) {
  if (clocks.lastTick != null && clocks.runningSeats.length) {
    const elapsed = Math.max(0, now - clocks.lastTick);
    for (const seat of clocks.runningSeats) {
      clocks.remainingMs[seat] = Math.max(0, clocks.remainingMs[seat] - elapsed);
    }
  }
  clocks.lastTick = now;
  clocks.runningSeats = newRunningSeats;
  return clocks;
}

// Running seats whose budget has hit zero as of the most recent tick() - the
// caller is responsible for actually forfeiting them (durakEngine.js's
// removePlayer) and re-ticking afterward, since removing a seat can change
// whose clock should run next.
function expiredSeats(clocks) {
  return clocks.runningSeats.filter((seat) => clocks.remainingMs[seat] <= 0);
}

// Milliseconds until the soonest running seat would hit zero if nothing else
// changes first, or null if nobody is currently running - lets the caller
// schedule exactly one timer for "when do I need to re-check" instead of
// polling on an interval.
function msUntilNextExpiry(clocks) {
  if (!clocks.runningSeats.length) return null;
  let min = Infinity;
  for (const seat of clocks.runningSeats) min = Math.min(min, clocks.remainingMs[seat]);
  return min === Infinity ? null : min;
}

module.exports = { TOTAL_MS_PER_PLAYER, createClocks, tick, expiredSeats, msUntilNextExpiry };
