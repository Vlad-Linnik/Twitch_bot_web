// Re-evaluates an ALREADY STORED flag under today's rules.
//
// The queue on /admin/game-runs is a backlog of findings, and a finding can
// stop being one - a ceiling constant corrected, a check that was measuring
// our own rounding rather than the player's run. Without this the fix only
// helps future submissions, while every row the broken rule already wrote
// still has to be hand-clicked one at a time. That backlog is the cost this
// module exists to remove: 19 of the 20 flags open when it was written were
// one arithmetic bug in the Cloud Climber climb check.
//
// WHAT IT CAN REDO IS BOUNDED BY THE DOCUMENT, because the run itself is gone.
// GameRuns expires at run length, taking the server seed with it, and no
// driver can be re-simulated without that seed - the seed echoed in the replay
// header is exactly the one the driver contract says never to trust. So the
// only thing re-run here is rateCeilings, which needs nothing the flag does
// not already store: the score, the death climb, and the server's own elapsed
// time. Those are the same numbers the submit path fed it, so the recheck is
// not an approximation of that verdict - for these codes it IS that verdict.
//
// The timing heuristics are deliberately NOT re-run even where the replay was
// kept. For the checkpointing games the stored `replay` is only the tail the
// client sent, while the submit path analysed the stitched head and tail, and
// nothing on the document says which of the two a given row holds - so a
// re-run over a subset could quietly clear a real finding. A timing pattern is
// also precisely the finding this queue exists to put a human in front of.
"use strict";

const rateCeilings = require("./rateCeilings");
// Same policy module the submit path uses - no cycle, index.js does not
// require this one.
const { OBSERVATIONAL_CODES } = require("./index");

// Findings rateCeilings can reproduce from a stored flag alone. The two hard
// rejections it can also raise - impossiblePerEvent, legacyCapExceeded - are
// absent on purpose: they need the run's event count and its untokened flag,
// neither of which is stored, so they could only ever fail to reproduce and
// would clear a flag by not being checkable rather than by being wrong. They
// are hard 400s that never reach this collection anyway.
const RECHECKABLE_CODES = new Set(["climbMismatch", "highRate", "impossibleRate", "impossibleClimb"]);

// Can every finding on this flag be re-derived? One code outside the set
// leaves the whole flag to a human, however clean the rest of it comes back:
// clearing a run because part of its evidence is unreadable is the one
// mistake this module must not make.
function isRecheckable(flag) {
  const reasons = (flag && flag.reasons) || [];
  if (reasons.length === 0) return false;
  return reasons.every((r) => r && (RECHECKABLE_CODES.has(r.code) || OBSERVATIONAL_CODES.has(r.code)));
}

/**
 * @returns {{recheckable: boolean, cleared: boolean, reasons: Array}}
 *   cleared - today's rules make no finding at all about this run, so the flag
 *   is stale and the score it is holding can be published.
 */
function recheckFlag(flag) {
  if (!isRecheckable(flag)) return { recheckable: false, cleared: false, reasons: [] };

  // heldScore is the number under review; a flag that holds nothing (an
  // observational one, or one written before the hold policy) is judged on
  // what the player claimed, which is what the ceilings saw.
  const score = flag.heldScore != null ? flag.heldScore : flag.claimedScore;
  if (!Number.isFinite(score)) return { recheckable: false, cleared: false, reasons: [] };

  const result = rateCeilings.check({
    game: flag.game,
    score,
    elapsedMs: Number.isFinite(flag.serverElapsedMs) ? flag.serverElapsedMs : undefined,
    deathClimb: Number.isFinite(flag.heldDeathClimb) ? flag.heldDeathClimb : undefined,
  });

  return {
    recheckable: true,
    cleared: !result.reject && result.reasons.length === 0,
    reasons: result.reasons,
  };
}

module.exports = { RECHECKABLE_CODES, isRecheckable, recheckFlag };
