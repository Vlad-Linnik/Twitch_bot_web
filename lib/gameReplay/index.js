// Orchestrates verification of one solo-game score submission: decode the
// input log, re-simulate the run server-side, and decide what actually gets
// stored. routes/games.js calls exactly one function here (`verify`) and stays
// thin; all the anti-cheat policy lives in this file.
//
// ============================================================================
// DRIVER CONTRACT - frozen. A per-game module lives at ./<gameKey>.js and
// exports:
//
//   gameKey       string, must equal its filename
//   rulesVersion  integer, bumped whenever a gameplay constant changes. A
//                 replay recorded under a different version is NOT replayed
//                 (a deploy mid-run must never cost a player their score).
//   replay(events, seed, ctx) -> { score, simMs, detail?, structuralError? }
//
//     events  decoded events, each {dt, at, opcode, synthetic, args, a, b, c}
//             where `at` is ms since run start. See replayCodec.js.
//     seed    the SERVER's uint32 seed for this run - never the one echoed in
//             the replay header. Feed it to ReplayCodec.mulberry32.
//     ctx     { deadlineExceeded(), totalDurationMs, claimedScore, gameKey }
//             Poll deadlineExceeded() every few hundred events in any loop
//             that can run long; return normally when it goes true and the
//             caller degrades to unverified rather than failing the player.
//
//     Return `structuralError: "<reason>"` for something a real client could
//     not have produced (an unknown opcode, an illegal move the engine
//     refuses). That is a hard 400. Anything merely surprising should be
//     scored as best it can and left to the flagging path.
//
//   heuristics(events, seed, detail) -> [{code, detail}]   OPTIONAL
//     Game-specific bot detection on top of the generic timing tests.
// ============================================================================
"use strict";

const crypto = require("crypto");
const codec = require("../../public/js/games/engines/replayCodec");
const inputHeuristics = require("./inputHeuristics");
const rateCeilings = require("./rateCeilings");

// The six client-run games. Also the allowlist that makes the lazy require()
// below safe: `game` arrives from a URL parameter, so it must never reach a
// module path without being checked against a fixed set first.
const SOLO_GAMES = [
  "falling-blocks",
  "pipe-dodger",
  "2048",
  "minesweeper",
  "match-3",
  "cloud-climber",
];
const SOLO_GAME_SET = new Set(SOLO_GAMES);

// Replay runs inline on the request path: the engines are pure JS with no I/O
// and the payloads are small, so a deferred queue would buy a worker and a
// "your score appears later" regression for nothing. This budget is the
// safety valve - see tests/replayBudget.bench.js, which asserts p95 well
// under it. Exceeding it degrades the submission to unverified; it is never
// an error the player sees.
const REPLAY_BUDGET_MS = 150;

// Grace for network latency and server scheduling when comparing the run's
// simulated duration against the server's own wall clock.
const LATENCY_GRACE_MS = 3000;

// Games whose run length is fixed by the rules, so simulated time running
// PAST the server's clock is provably impossible rather than merely odd.
const FIXED_LENGTH_GAMES = new Set(["minesweeper", "match-3"]);

const HIGH_SEVERITY_CODES = new Set(["scoreMismatch", "impossibleRate", "impossibleClimb", "timeTravel"]);

const driverCache = new Map();

function isSoloGame(game) {
  return SOLO_GAME_SET.has(game);
}

// Lazy per-game require, so adding a game never means editing a shared
// registry - that is what keeps the five wave-1 agents off each other's files.
function getDriver(game) {
  if (!isSoloGame(game)) return null;
  if (driverCache.has(game)) return driverCache.get(game);
  let driver = null;
  try {
    driver = require("./" + game);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    // No driver yet (cloud-climber, and any game mid-migration) - the caller
    // falls back to the rate ceilings.
    driver = null;
  }
  driverCache.set(game, driver);
  return driver;
}

// Identifies one exact submission, so a client retrying after a lost response
// can be recognised as the same request rather than a second attempt (see
// gameRunsRepo.findConsumedRun).
//
// Keyed on runId, NOT on the replay bytes alone: two runs that recorded no
// input at all - an instant death in Pipe Dodger - produce byte-identical
// logs, and hashing only those would make an honest player's second failed
// attempt look like a resubmission. Detecting a genuinely replayed input log
// needs no hash anyway: a different run carries a different server seed, so
// the same keystrokes simply score differently.
function hashReplay(runId, replayText) {
  return crypto.createHash("sha256").update(String(runId)).update("|").update(replayText || "").digest("hex");
}

function severityFor(reasons) {
  let timing = 0;
  for (const reason of reasons) {
    if (HIGH_SEVERITY_CODES.has(reason.code)) return "high";
    if (reason.code === "constantCadence" || reason.code === "lowJitter" || reason.code === "superhumanApm") {
      timing++;
    }
  }
  if (timing >= 2) return "medium";
  if (reasons.some((r) => r.code === "highRate" || r.code === "climbMismatch")) return "medium";
  return "low";
}

// The unverified path: no replay to re-simulate, so all we have is "could this
// score have grown this fast". Used for cloud-climber (no driver yet), legacy
// clients, and replays that blew the time budget.
function unverifiedOutcome({ game, claimedScore, serverElapsedMs, eventCount, deathClimb, reasons, untokened }) {
  const ceiling = rateCeilings.check({
    game,
    score: claimedScore,
    elapsedMs: serverElapsedMs,
    eventCount,
    deathClimb,
    untokened,
  });
  const all = reasons.concat(ceiling.reasons);
  if (ceiling.reject) {
    return { reject: true, status: 400, error: "implausible", reasons: all, severity: "high", verified: false };
  }
  return {
    reject: false,
    score: claimedScore,
    verified: false,
    reasons: all,
    severity: severityFor(all),
  };
}

/**
 * @param {object} input
 *   game            solo game key
 *   mode            "off" | "observe" | "enforce"
 *   run             the GameRuns document just consumed
 *   replayText      base64url log, or null/"" for a legacy submit
 *   claimedScore    the client's own number
 *   deathClimb      cloud-climber only
 *   serverElapsedMs server-measured run duration (usedAt - startedAt)
 * @returns {{reject:boolean, status?:number, error?:string, score?:number,
 *            verified:boolean, reasons:Array, severity:string,
 *            simElapsedMs:number|null, replayHash:string|null,
 *            replayBytes:number|null}}
 */
function verify(input) {
  const { game, mode, run, replayText, claimedScore, deathClimb, serverElapsedMs } = input;
  const base = { simElapsedMs: null, replayHash: null, replayBytes: null };

  // No log at all - an old cached client, a beacon too large to send one, or a
  // game that has no replay verification in the first place.
  if (!replayText) {
    const reasons = [];
    if (input.legacyClient) {
      reasons.push({ code: "legacyClient", detail: null });
    } else if (getDriver(game)) {
      // A game that CAN be verified but wasn't is worth a look.
      reasons.push({ code: "noReplay", detail: null });
    }
    // A game with no driver (cloud-climber) sends no log by design, so its
    // absence is the expected state, not a finding. Flagging it would put a
    // document in the review queue for every single honest play and drown the
    // signal the queue exists for - the rate ceilings below are its real check.
    return {
      ...base,
      ...unverifiedOutcome({
        game,
        claimedScore,
        serverElapsedMs,
        eventCount: null,
        deathClimb,
        reasons,
        // A legacy client carries no run at all, so there is no server-measured
        // duration to test - only the absolute cap can catch a forgery.
        untokened: Boolean(input.legacyClient),
      }),
    };
  }

  base.replayHash = hashReplay(run.runId, replayText);

  let decoded;
  try {
    decoded = codec.decode(replayText, codec.LIMITS[game]);
  } catch (err) {
    if (!err.replayFormat) throw err;
    // Structurally impossible: no real client produces this.
    return {
      ...base,
      reject: true,
      status: 400,
      error: "replay",
      verified: false,
      reasons: [{ code: "malformedReplay", detail: { message: err.message } }],
      severity: "high",
    };
  }
  base.replayBytes = decoded.byteLength;
  base.simElapsedMs = decoded.totalDurationMs;

  if (decoded.gameKey !== game) {
    return {
      ...base,
      reject: true,
      status: 400,
      error: "replay",
      verified: false,
      reasons: [{ code: "wrongGame", detail: { claimed: decoded.gameKey, expected: game } }],
      severity: "high",
    };
  }

  // Marathon games (falling-blocks, 2048) checkpoint the head of their input
  // log separately - run/checkpoint.json - because a browser caps a
  // keepalive:true fetch body at 64kB, which a long log outgrows. The final
  // submit's `replayText` is therefore only the TAIL since the last
  // checkpoint (soloRunClient.js's finish() slices from the watermark), so
  // replaying it alone starts the engine from an empty board and simulates
  // only the last few checkpoint-intervals' worth of play - the rest of the
  // game just never happened as far as the server is concerned. Stitch the
  // checkpointed head back on before replaying. The recorder tracks event dt
  // continuously across the checkpoint boundary (only the EVENT SET is
  // sliced client-side, never the clock), so the tail's own zero-based `at`
  // values are exactly "time since the head ended" - shifting them by the
  // head's total span makes them absolute again.
  if (run.checkpointReplay) {
    try {
      const head = codec.decode(run.checkpointReplay, codec.LIMITS[game]);
      if (head.gameKey === game && head.rulesVersion === decoded.rulesVersion && head.seed === decoded.seed) {
        const shiftedTail = decoded.events.map((ev) => ({ ...ev, at: ev.at + head.eventSpanMs }));
        decoded = { ...decoded, events: head.events.concat(shiftedTail) };
      }
    } catch {
      // A corrupt/stale stored checkpoint is our bug, not the player's - fall
      // back to replaying just the tail rather than failing the submission.
    }
  }

  const driver = getDriver(game);
  const reasons = [];

  // A deploy landing mid-run changes the rules underneath the player. Accept
  // what they claim and flag it; punishing them for our release timing would
  // be the worst false positive of all.
  if (driver && decoded.rulesVersion !== driver.rulesVersion) {
    return {
      ...base,
      ...unverifiedOutcome({
        game,
        claimedScore,
        serverElapsedMs,
        eventCount: decoded.events.length,
        deathClimb,
        reasons: [
          { code: "staleRules", detail: { replay: decoded.rulesVersion, server: driver.rulesVersion } },
        ],
      }),
    };
  }

  if (!driver) {
    // No replay verification for this game yet (cloud-climber). The log is
    // still recorded and hashed; the rate ceilings are the actual check.
    return {
      ...base,
      ...unverifiedOutcome({
        game,
        claimedScore,
        serverElapsedMs,
        eventCount: decoded.events.length,
        deathClimb,
        reasons: [],
      }),
    };
  }

  // ---- re-simulate -------------------------------------------------------
  const startedAt = Date.now();
  let timedOut = false;
  const ctx = {
    gameKey: game,
    totalDurationMs: decoded.totalDurationMs,
    claimedScore,
    deadlineExceeded() {
      if (Date.now() - startedAt > REPLAY_BUDGET_MS) {
        timedOut = true;
        return true;
      }
      return false;
    },
  };

  let result;
  try {
    result = driver.replay(decoded.events, run.seed, ctx);
  } catch (err) {
    // A driver throwing is our bug, not the player's cheating - never take
    // their score away over it.
    return {
      ...base,
      ...unverifiedOutcome({
        game,
        claimedScore,
        serverElapsedMs,
        eventCount: decoded.events.length,
        deathClimb,
        reasons: [{ code: "driverError", detail: { message: err.message } }],
      }),
    };
  }

  if (result && result.structuralError) {
    return {
      ...base,
      reject: true,
      status: 400,
      error: "replay",
      verified: false,
      reasons: [{ code: "illegalReplay", detail: { reason: result.structuralError } }],
      severity: "high",
    };
  }

  if (timedOut) {
    return {
      ...base,
      ...unverifiedOutcome({
        game,
        claimedScore,
        serverElapsedMs,
        eventCount: decoded.events.length,
        deathClimb,
        reasons: [{ code: "replayTimeout", detail: { budgetMs: REPLAY_BUDGET_MS } }],
      }),
    };
  }

  const serverScore = Math.max(0, Math.floor(result.score || 0));
  const simMs = Number.isFinite(result.simMs) ? result.simMs : decoded.totalDurationMs;
  base.simElapsedMs = simMs;

  // ---- wall-clock cross-check -------------------------------------------
  // STRICTLY one-directional. serverElapsed >> simElapsed is completely
  // normal - Falling Blocks pauses on blur, the leave dialog sits open, 2048
  // resumes a day later - so only the impossible direction is checked.
  if (simMs > serverElapsedMs + LATENCY_GRACE_MS) {
    const detail = { simMs, serverElapsedMs };
    if (FIXED_LENGTH_GAMES.has(game)) {
      return {
        ...base,
        reject: true,
        status: 400,
        error: "replay",
        verified: false,
        reasons: [{ code: "timeTravel", detail }],
        severity: "high",
      };
    }
    reasons.push({ code: "timeTravel", detail });
  }

  // ---- score reconciliation ---------------------------------------------
  let storedScore = serverScore;
  if (serverScore < claimedScore) {
    reasons.push({ code: "scoreMismatch", detail: { claimed: claimedScore, computed: serverScore } });
  } else if (serverScore > claimedScore) {
    // Never award more than the player themselves claimed. A server score
    // that exceeds the client's is a symptom of an engine divergence - a BUG
    // to investigate, not evidence of cheating.
    storedScore = claimedScore;
    reasons.push({ code: "scoreOverrun", detail: { claimed: claimedScore, computed: serverScore } });
  }

  // ---- bot heuristics ----------------------------------------------------
  for (const reason of inputHeuristics.analyze(decoded.events, game)) reasons.push(reason);
  if (typeof driver.heuristics === "function") {
    try {
      for (const reason of driver.heuristics(decoded.events, run.seed, result.detail)) reasons.push(reason);
    } catch {
      // A misbehaving optional heuristic must never fail a submission.
    }
  }

  // Rate ceilings still run on a verified replay, but only ever as a FLAG:
  // the replay is authoritative, so a ceiling firing here means the ceiling is
  // wrong, and rejecting would take an honest score over our own bad constant.
  const ceiling = rateCeilings.check({
    game,
    score: storedScore,
    elapsedMs: serverElapsedMs,
    eventCount: decoded.events.length,
    deathClimb,
  });
  for (const reason of ceiling.reasons) reasons.push(reason);
  if (ceiling.reject) {
    reasons.push({ code: "ceilingDisagreesWithReplay", detail: ceiling.reasons });
  }

  return {
    ...base,
    reject: false,
    // observe mode measures without consequences: flags are recorded, but the
    // player's own number is what gets stored. A game is only promoted to
    // enforce once its client/server agreement rate has been observed.
    score: mode === "enforce" ? storedScore : claimedScore,
    verified: true,
    reasons,
    severity: severityFor(reasons),
  };
}

module.exports = {
  SOLO_GAMES,
  SOLO_GAME_SET,
  REPLAY_BUDGET_MS,
  LATENCY_GRACE_MS,
  isSoloGame,
  getDriver,
  hashReplay,
  verify,
};
