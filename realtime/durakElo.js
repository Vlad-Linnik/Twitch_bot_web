// Pure, I/O-free Elo rating math for multiplayer Durak. No ws/Mongo/Express
// references on purpose, same convention as durakEngine.js - realtime/
// durakRoomManager.js is the only caller, and owns fetching current ratings
// from db/gameScoresRepo.js and persisting the deltas this computes.
//
// Standard 1v1 Elo doesn't have an opinion about N>2 players finishing in a
// ranked order. This generalizes it via round-robin pairwise decomposition -
// the well-known approach for free-for-all games: treat the result as every
// player having played a virtual 1v1 against every other player, with the
// "winner" of each virtual match being whoever finished better (a tie if they
// finished equal), then average each player's (actual - expected) score
// across their (n-1) opponents. Averaging instead of summing is what makes
// n=2 collapse to an identical result to plain classic Elo, rather than a
// 6-player free-for-all producing much larger swings than a 1v1 purely
// because there were more opponents to be compared against.
//
// This is also what gives the requested asymmetry for free: a big rating gap
// pushes the favorite's expected score close to 1 in every pairwise
// comparison, so beating a much weaker opponent (actual=1) barely moves
// (actual - expected), while losing to them (actual=0) is a huge miss - and
// the same logic applies to every pair independently, so it holds in a
// 6-player match exactly the same way it holds 1v1.
"use strict";

const DEFAULT_RATING = 300;
const K_FACTOR = 32;

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

// One entry's unrounded share of the pairwise exchange against every other
// entry - the shared core both computeEloDeltas (a full, simultaneous
// settlement) and computeSingleEloDelta (one seat, settled on its own) build
// on. Pairwise Elo is zero-sum FOR A GIVEN PAIR regardless of when each
// side's contribution actually gets rounded - see computeSingleEloDelta's
// comment for why that matters.
function rawDelta(entries, i, kFactor) {
  let total = 0;
  for (let j = 0; j < entries.length; j++) {
    if (i === j) continue;
    const expected = expectedScore(entries[i].rating, entries[j].rating);
    const actual = entries[i].place === entries[j].place ? 0.5 : entries[i].place < entries[j].place ? 1 : 0;
    total += actual - expected;
  }
  return (kFactor * total) / (entries.length - 1);
}

// entries: [{ rating, place }], one per seat, in seat order. `place` is a
// 1-based (or 0-based, only relative order matters) finishing rank where
// LOWER is better; equal `place` values are a tie. Returns a same-length,
// same-order array of integer rating deltas.
function computeEloDeltas(entries, { kFactor = K_FACTOR } = {}) {
  const n = entries.length;
  const deltas = new Array(n).fill(0);
  if (n < 2) return deltas;

  // raw holds each player's unrounded share - pairwise Elo is zero-sum, so
  // raw always sums to ~0 (floating-point noise only). Rounding each entry
  // independently can still leave the integer total a point or two off zero
  // (see durakElo.test.js's "deltas sum to zero" case) - fixed up below.
  const raw = entries.map((_, i) => rawDelta(entries, i, kFactor));
  for (let i = 0; i < n; i++) deltas[i] = Math.round(raw[i]);

  // Largest-remainder fixup: nudge whichever entries' rounding strayed
  // furthest from their raw value by +-1 until the match's total is exactly
  // zero, so a game can never quietly create or destroy rating points.
  let deficit = -deltas.reduce((sum, v) => sum + v, 0);
  if (deficit !== 0) {
    const bySlack = raw
      .map((r, i) => ({ i, slack: r - deltas[i] }))
      .sort((a, b) => (deficit > 0 ? b.slack - a.slack : a.slack - b.slack));
    for (let k = 0; k < Math.abs(deficit); k++) deltas[bySlack[k].i] += deficit > 0 ? 1 : -1;
  }

  return deltas;
}

// Settles a single seat's delta in isolation, for a player durakRoomManager.js
// is paying out THE MOMENT they finish rather than making them wait for the
// rest of the table (see its payOutEarlyFinisher) - every other seat in
// `entries` may be a real, already-locked placement OR a "hasn't finished yet"
// placeholder (any place number worse than this seat's own - see the caller),
// since this seat's own delta only needs each pairwise (actual - expected)
// against opponents whose relative order to THIS seat is already certain, not
// their eventual placement relative to EACH OTHER.
//
// Deliberately skips computeEloDeltas' largest-remainder fixup: that
// redistribution only makes sense across seats being settled together in one
// call, and here every other row is synthetic and will never itself be paid
// from this call, so nudging one to zero out this call's total would just be
// noise. The rounding this seat's own delta gets is still off by at most 0.5,
// same bound as any other seat's rounding - see durakRoomManager.js's
// updateRatings() for how the seats still active when the match truly ends
// get the batch fixup back, and why paying some seats out earlier means the
// match as a whole is no longer guaranteed to net to exactly zero (an
// accepted, small cost of not making early finishers wait).
function computeSingleEloDelta(entries, seatIndex, { kFactor = K_FACTOR } = {}) {
  if (entries.length < 2) return 0;
  return Math.round(rawDelta(entries, seatIndex, kFactor));
}

// Turns a finished realtime/durakEngine.js `state` into a per-seat finishing
// order Elo can score. Lower `place` is better. Rules, in priority order:
//
//  1. A seat that actually emptied its hand (state.players[seat].finishRank
//     set) keeps that rank - 1 is best, matching "the first player to get out
//     gets the most points".
//  2. `result.kind === "draw"`: the seats that finished in the same
//     deck-exhaustion instant (result.seats) are re-tied to the BEST rank
//     among them, overriding their individually-sequential finishRanks -
//     the engine assigns those sequentially even though the game itself
//     calls the outcome a draw between them (see durakEngine.js's
//     checkOutPlayers), and Elo should treat a declared draw as an actual
//     tie ("игроки у которых ничья" split evenly), not a hidden ranking.
//  3. A seat that left/timed out mid-game (state.players[seat].leaveRank set)
//     keeps that rank too - counted DOWN from n (worst) in leaving order, so
//     leaving is never a flat "everyone who quit ties for last" penalty:
//     whoever quit first is ranked worse than whoever quit later, exactly
//     the same way an earlier finisher outranks a later one. No separate
//     penalty beyond the placement itself - a quitter's Elo comes from
//     pairwise comparisons against this rank like anyone else's.
//  4. `result.kind === "durak"`: the sole seat that never finished OR left
//     (result.loserSeat) is placed one worse than the best-ranked FINISHER
//     (not leaver - see maxFinishPlace below) - "дурак теряет больше всех"
//     among people who actually finished, but still beats every quitter for
//     having stuck the game out to the end.
//  5. `result.kind === "left-early-win"`: the survivor (result.winnerSeat) is
//     placed at rank 0, better than anyone, including seats that had already
//     finished normally before the others quit - there's no principled way
//     to rank a forfeit win against a normal finish, so it's treated as the
//     best possible outcome.
//  6. Anything still unplaced (shouldn't normally happen - every seat is
//     accounted for by 1-5 above once the game has actually ended - kept as
//     a defensive fallback) shares the single worst rank.
function buildPlacements(state) {
  const n = state.players.length;
  const place = new Array(n).fill(null);

  let maxFinishPlace = 0;
  state.players.forEach((p, seat) => {
    if (p.finishRank != null) {
      place[seat] = p.finishRank;
      if (p.finishRank > maxFinishPlace) maxFinishPlace = p.finishRank;
    }
  });

  const result = state.result || {};

  if (result.kind === "draw" && result.seats && result.seats.length) {
    const known = result.seats.map((s) => place[s]).filter((v) => v != null);
    if (known.length) {
      const tie = Math.min(...known);
      for (const s of result.seats) place[s] = tie;
    }
  }

  state.players.forEach((p, seat) => {
    if (place[seat] == null && p.leaveRank != null) place[seat] = p.leaveRank;
  });

  if (result.kind === "durak") {
    place[result.loserSeat] = maxFinishPlace + 1;
  }

  if (result.kind === "left-early-win") {
    place[result.winnerSeat] = 0;
  }

  // Derived from the FINAL place[] values (post draw-retie), not
  // maxFinishPlace - a retied draw can lower a seat's place below its raw
  // sequential finishRank, and this fallback must reflect what actually got
  // assigned, not what almost got assigned before the retie stepped in.
  const worst = Math.max(0, ...place.filter((v) => v != null)) + 1;
  for (let seat = 0; seat < n; seat++) {
    if (place[seat] == null) place[seat] = worst;
  }

  return place.map((p, seat) => ({ seat, place: p }));
}

module.exports = { DEFAULT_RATING, K_FACTOR, expectedScore, computeEloDeltas, computeSingleEloDelta, buildPlacements };
