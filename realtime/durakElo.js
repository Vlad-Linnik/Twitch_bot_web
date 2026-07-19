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

// entries: [{ rating, place }], one per seat, in seat order. `place` is a
// 1-based (or 0-based, only relative order matters) finishing rank where
// LOWER is better; equal `place` values are a tie. Returns a same-length,
// same-order array of integer rating deltas.
function computeEloDeltas(entries, { kFactor = K_FACTOR } = {}) {
  const n = entries.length;
  const deltas = new Array(n).fill(0);
  if (n < 2) return deltas;

  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const expected = expectedScore(entries[i].rating, entries[j].rating);
      const actual = entries[i].place === entries[j].place ? 0.5 : entries[i].place < entries[j].place ? 1 : 0;
      total += actual - expected;
    }
    deltas[i] = Math.round((kFactor * total) / (n - 1));
  }
  return deltas;
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
//  3. `result.kind === "durak"`: the sole non-finisher (result.loserSeat) is
//     placed one worse than anyone who ever finished - "дурак теряет
//     больше всех".
//  4. `result.kind === "left-early-win"`: the survivor (result.winnerSeat) is
//     placed at rank 0, better than anyone, including seats that had already
//     finished normally before the others quit - there's no principled way
//     to rank a forfeit win against a normal finish, so it's treated as the
//     best possible outcome.
//  5. Anything still unplaced (players who left/timed out without ever
//     finishing, or - in the rare "everyone quit" empty draw - just never
//     resolved) shares the single worst rank: quitting is treated as at
//     least as bad as being the seat that never got out.
function buildPlacements(state) {
  const n = state.players.length;
  const place = new Array(n).fill(null);

  state.players.forEach((p, seat) => {
    if (p.finishRank != null) place[seat] = p.finishRank;
  });

  const result = state.result || {};

  if (result.kind === "draw" && result.seats && result.seats.length) {
    const known = result.seats.map((s) => place[s]).filter((v) => v != null);
    if (known.length) {
      const tie = Math.min(...known);
      for (const s of result.seats) place[s] = tie;
    }
  }

  let maxPlace = place.reduce((m, v) => (v != null && v > m ? v : m), 0);

  if (result.kind === "durak") {
    maxPlace += 1;
    place[result.loserSeat] = maxPlace;
  }

  if (result.kind === "left-early-win") {
    place[result.winnerSeat] = 0;
  }

  const worst = maxPlace + 1;
  for (let seat = 0; seat < n; seat++) {
    if (place[seat] == null) place[seat] = worst;
  }

  return place.map((p, seat) => ({ seat, place: p }));
}

module.exports = { DEFAULT_RATING, K_FACTOR, expectedScore, computeEloDeltas, buildPlacements };
