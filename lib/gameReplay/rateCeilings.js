// Physics/rules-derived upper bounds on how fast a score can possibly grow.
//
// Two jobs:
//  1. Cloud Climber has no replay verification yet (~40 gameplay RNG sites and
//     analog drag steering make an engine extraction its own project), so these
//     bounds ARE its anti-cheat.
//  2. For the five replay-verified games these are the fallback whenever a
//     submission couldn't actually be verified - replay budget exceeded, an
//     oversized leave-page beacon, or a stale client still on the legacy shape.
//
// Every number below is derived from a constant in the game itself, not
// guessed from observed scores, so it can be re-checked against the source.
// Constants are duplicated here rather than imported: public/js/games/*.js are
// browser IIFEs with no exports. Same hand-sync convention the repo already
// uses for config/defaultChannelConfig.json and data/commands.js - if you
// change a constant in the game, change it here.
"use strict";

// KEEP IN SYNC WITH public/js/games/cloud-climber.js
//   SCORE_MULTIPLIER = 8 (:157), MONSTER_KILL_BONUS = 25 (:97)
//   => score = 0.8 * climbPx + 200 * kills
//   JETPACK_SPEED = -900 px/s is the highest SUSTAINABLE climb rate in the
//   game (a spring's 1350 px/s is instantaneous: its ballistic arc rises
//   536px over 0.794s, i.e. ~675 px/s even assuming a spring on every apex
//   and zero fall time). MIN_GAP = 50 caps platforms passed at 18/s, and
//   MONSTER_CHANCE_MAX = 0.10 caps monster spawns at 1.8/s.
const CLOUD_CLIMBER = {
  maxClimbPxPerSec: 900,
  maxKillsPerSec: 1.8,
  scorePerPx: 0.8,
  scorePerKill: 200,
};

const CEILINGS = {
  // 0.8*900 + 200*1.8 = 1080 - rounded up for timing slop. Above this is
  // provably unreachable, so it is safe to refuse outright.
  "cloud-climber": {
    hardScorePerSec: 1200,
    flagScorePerSec: 500,
  },
  // SPAWN_SPACING = 235px at SPEED_MAX = 260px/s => >=0.9s per point. The
  // tightest bound of the six by a wide margin.
  "pipe-dodger": {
    hardScorePerSec: 1.2,
    flagScorePerSec: 0.9,
  },
  // A level-30 tetris is 24000 points but needs at least 4 piece locks to set
  // up, so this is deliberately coarse - replay is the real check here.
  "falling-blocks": {
    hardScorePerSec: 1500,
    flagScorePerSec: 600,
  },
  // Score is boards cleared; a 9x9 Beginner board needs ~10 clicks minimum,
  // and the run is at most 6 minutes.
  minesweeper: {
    hardScorePerSec: 140 / 360,
    maxScorePerEvent: 0.1,
  },
  // Fixed 3-minute run.
  "match-3": {
    hardScorePerSec: 400,
    maxScorePerEvent: 200,
  },
  // Every point comes from a merge, and a merge needs a move.
  2048: {
    hardScorePerSec: 1000,
    maxScorePerEvent: 100,
  },
};

// Absolute per-game ceiling for a submission carrying NO run token at all.
//
// Such a submission has no server-measured duration, so the rate tests above
// have nothing to work with - which would leave "just omit the runId" as a
// complete bypass of the whole anti-cheat. These caps close that: every one is
// at least ~10x the best score the game realistically produces, so no honest
// player on a stale cached client is ever affected, while a forged 1.9M is
// refused outright.
//
// A run WITH a token is not subject to these - a verified replay may score
// whatever it legitimately scored.
const LEGACY_CAP = {
  // A strong marathon reaches the tens of thousands.
  "falling-blocks": 200000,
  // One point per pipe pair; a great run is under a hundred.
  "pipe-dodger": 500,
  // A 2048 tile is worth roughly 20k.
  2048: 200000,
  // Score is boards cleared in six minutes - single digits to ~20.
  minesweeper: 100,
  // A few thousand points per fixed 3-minute run.
  "match-3": 50000,
  // ~0.8 points per pixel climbed; a long run is 10-20k.
  "cloud-climber": 300000,
};

// Runs this short or this cheap have huge rate variance (a 3-second run that
// scored 40 is a perfectly ordinary 13 points/sec) and are worthless to a
// cheater anyway, so they're exempt from the rate test.
const MIN_ELAPSED_MS = 10000;
const MIN_SCORE = 500;

// Returns {reject, reasons: [{code, detail}]}. `elapsedMs` must be the SERVER's
// own measurement (usedAt - startedAt), never a client-supplied duration.
function check({ game, score, elapsedMs, eventCount, deathClimb, untokened }) {
  const rules = CEILINGS[game];
  const reasons = [];

  // No run token at all: the timing tests below are blind, so the absolute cap
  // is the only thing standing between a forged number and the leaderboard.
  if (untokened && LEGACY_CAP[game] && score > LEGACY_CAP[game]) {
    return {
      reject: true,
      reasons: [{ code: "legacyCapExceeded", detail: { score, cap: LEGACY_CAP[game] } }],
    };
  }

  if (!rules) return { reject: false, reasons };

  // A legacy submit carries no run, so there is no server-measured duration to
  // test against - the per-event bound below is all that applies.
  const timed = Number.isFinite(elapsedMs);
  const seconds = Math.max(0.001, (timed ? elapsedMs : 0) / 1000);

  if (timed && elapsedMs >= MIN_ELAPSED_MS && score >= MIN_SCORE) {
    const perSec = score / seconds;
    if (rules.hardScorePerSec && perSec > rules.hardScorePerSec) {
      return {
        reject: true,
        reasons: [
          {
            code: "impossibleRate",
            detail: {
              scorePerSec: Number(perSec.toFixed(2)),
              limit: rules.hardScorePerSec,
              elapsedMs,
              score,
            },
          },
        ],
      };
    }
    if (rules.flagScorePerSec && perSec > rules.flagScorePerSec) {
      reasons.push({
        code: "highRate",
        detail: { scorePerSec: Number(perSec.toFixed(2)), limit: rules.flagScorePerSec },
      });
    }
  }

  // Score per input is a second, independent bound: you cannot score without
  // acting, whatever the clock says.
  if (rules.maxScorePerEvent && Number.isFinite(eventCount) && eventCount > 0) {
    const ceiling = rules.maxScorePerEvent * eventCount;
    if (score > ceiling) {
      return {
        reject: true,
        reasons: [
          { code: "impossiblePerEvent", detail: { score, eventCount, ceiling } },
        ],
      };
    }
  }

  // Cloud Climber only: two free consistency checks that need no physics.
  // Score is climb plus kill bonuses, so it can never be BELOW the climb
  // component alone - and the climb itself is bounded by the same 900px/s.
  if (game === "cloud-climber" && Number.isFinite(deathClimb) && deathClimb > 0) {
    if (score < Math.floor(CLOUD_CLIMBER.scorePerPx * deathClimb)) {
      reasons.push({
        code: "climbMismatch",
        detail: { score, deathClimb, expectedAtLeast: Math.floor(CLOUD_CLIMBER.scorePerPx * deathClimb) },
      });
    }
    if (timed && elapsedMs >= MIN_ELAPSED_MS && deathClimb > CLOUD_CLIMBER.maxClimbPxPerSec * seconds) {
      return {
        reject: true,
        reasons: [
          {
            code: "impossibleClimb",
            detail: { deathClimb, limit: Math.floor(CLOUD_CLIMBER.maxClimbPxPerSec * seconds) },
          },
        ],
      };
    }
  }

  return { reject: false, reasons };
}

module.exports = { CEILINGS, CLOUD_CLIMBER, LEGACY_CAP, MIN_ELAPSED_MS, MIN_SCORE, check };
