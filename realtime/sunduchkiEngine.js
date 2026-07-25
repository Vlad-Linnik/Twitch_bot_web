// Pure, I/O-free N-player (2-6) "Сундучки" (Sunduchki / "chests") rules
// engine. No ws/Mongo/Express references on purpose, same convention as
// durakEngine.js - realtime/sunduchkiRoomManager.js is the only caller; it
// owns all I/O (sockets, Mongo) and trusts nothing from the network without
// routing it through the validation here.
//
// Go-Fish family game: each of 2-6 players is dealt 4 cards, the rest form a
// draw pile. On your turn you pick a target (constrained by rules.
// questionTarget) and ask for a RANK you already hold at least one card of
// (no bluffing - enforced here, not just by the client). The engine checks
// the target's real hand and, if they hold any, transfers ALL of them to you
// at once (honest reveal, not a blind guess) - this, plus every ask/result
// being broadcast to the whole table (realtime/sunduchkiRoomManager.js's
// job, not this file's), is what makes the game "logical": everyone can
// listen and deduce who holds what, the same as at a real table. A hit lets
// you go again; a miss draws one card from the deck and passes the turn.
// Collecting all 4 cards of a rank lays the "chest" down immediately (always
// public, per the house rule this repo's game was built with) and removes
// that rank from play for good. The game ends once every rank has been
// chested by someone.
"use strict";

const SUITS = ["S", "H", "D", "C"];

function ranksForDeckSize(deckSize) {
  const startRank = deckSize === 52 ? 2 : 6;
  const ranks = [];
  for (let rank = startRank; rank <= 14; rank++) ranks.push(rank);
  return ranks;
}

function createDeck(deckSize) {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of ranksForDeckSize(deckSize)) cards.push({ suit, rank });
  }
  return cards;
}

// rules.deckSize travels over the network as "36" | "52" (a <select>
// element's value is always a string) - this is the one place that turns it
// into the number createDeck expects. Unlike Durak there's no "auto" (no
// player-count-driven default worth guessing at here), so an unrecognized
// value just falls back to 36.
function normalizeDeckSize(value) {
  if (value === 52 || value === "52") return 52;
  return 36;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
}

function isActive(state, seat) {
  const p = state.players[seat];
  return !!p && !p.left;
}

function activeSeats(state) {
  return state.players.map((_, i) => i).filter((i) => isActive(state, i));
}

// Next active seat clockwise of `seat` (wrapping); falls back to `seat`
// itself if no other active seat exists - the game should already be over
// by then (see removePlayer/checkGameEnd), not a reachable path in normal play.
function nextActiveSeatAfter(state, seat) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const candidate = (seat + i) % n;
    if (isActive(state, candidate)) return candidate;
  }
  return seat;
}

function claimedRanks(state) {
  const s = new Set();
  for (const p of state.players) for (const r of p.chests) s.add(r);
  return s;
}

// The ranks `seat` may currently ask about: present in their own hand (the
// no-bluffing rule) and not already fully chested by anyone (impossible to
// hold a card of a claimed rank anyway - all 4 are already accounted for -
// this filter is a defensive no-op, not load-bearing).
function legalAskRanks(state, seat) {
  const claimed = claimedRanks(state);
  const ranks = new Set();
  for (const c of state.players[seat].hand) if (!claimed.has(c.rank)) ranks.add(c.rank);
  return [...ranks].sort((a, b) => a - b);
}

// rules.questionTarget: "next" (only the immediate clockwise seat may be
// asked - the wiki's base rule) or "any" (any other active seat - the more
// Go-Fish-like variant). Either way turn ROTATION on a miss is always
// clockwise; this only constrains who a question may be aimed AT.
function legalTargets(state, seat) {
  if (state.rules.questionTarget === "next") {
    const t = nextActiveSeatAfter(state, seat);
    return t === seat ? [] : [t];
  }
  return activeSeats(state).filter((s) => s !== seat);
}

function hasLegalAsk(state, seat) {
  return legalAskRanks(state, seat).length > 0 && legalTargets(state, seat).length > 0;
}

function ok(state) {
  return { ok: true, state };
}
function err(error) {
  return { ok: false, error };
}

function pushLog(state, entry) {
  state.log.push(entry);
  // Defensive cap on a very long game's internal history - serialization
  // already only ever shows the client the tail of this (see
  // serializePublicState), this just stops the array itself growing forever.
  if (state.log.length > 200) state.log.shift();
}

// Lays down every rank the seat now holds all 4 of (normally at most one at
// a time, but a lucky deck draw could theoretically complete more than the
// rank just asked about - not reachable since a draw only ever adds ONE
// card - kept general rather than assuming exactly one). Returns the list of
// newly completed ranks for the caller to fold into its log entry.
function layDownCompletedChests(state, seat) {
  const player = state.players[seat];
  const counts = new Map();
  for (const c of player.hand) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  const completed = [];
  for (const [rank, count] of counts) {
    if (count === 4) {
      player.hand = player.hand.filter((c) => c.rank !== rank);
      player.chests.push(rank);
      completed.push(rank);
    }
  }
  return completed;
}

function nextLeaveRank(state) {
  const used = state.players.map((p) => p.leaveRank).filter((r) => r != null);
  return used.length ? Math.min(...used) - 1 : state.players.length;
}

// Once the deck is empty, a miss changes NOTHING (no draw, just a turn
// rotation) - so if no seat can ever again reach a hand that overlaps its
// own, no future ask can EVER be a hit again (nothing will move any card
// ever again), and the game is permanently frozen exactly as it stands. This
// is what actually guarantees termination, not just "every hand happens to
// be empty" (a real playthrough can easily reach deck-empty with several
// ranks each still split, unrecoverably, across two or more hands - a true
// stalemate, not a bug to route around).
//
// Deliberately checks overlap only against legalTargets(state, seat), not
// every other active seat - under rules.questionTarget==="next" a seat can
// ONLY ever ask its immediate clockwise neighbor, for as long as the game
// runs, so a rank shared with some non-adjacent seat can never actually be
// exploited and must not be read as "progress is still possible" (an
// overlap check against every pair caused exactly this: a real deadlock
// where every ADJACENT pair was a permanent miss looked "unstuck" because
// unreachable non-adjacent pairs happened to share a rank, and the game
// spun forever). Checking each seat's own forward reachable target(s) still
// covers every pair that could ever matter exactly once - overlap is
// symmetric, so there's no need to also check the reverse direction.
function hasAnyReachableOverlap(state) {
  for (const seat of activeSeats(state)) {
    const ranksSeat = new Set(state.players[seat].hand.map((c) => c.rank));
    if (!ranksSeat.size) continue;
    for (const target of legalTargets(state, seat)) {
      for (const c of state.players[target].hand) if (ranksSeat.has(c.rank)) return true;
    }
  }
  return false;
}

function checkGameEnd(state) {
  if (state.phase !== "playing") return;
  if (claimedRanks(state).size >= state.totalRanks) {
    state.phase = "finished";
    state.result = { kind: "finished" };
    return;
  }
  if (state.deck.length === 0 && !hasAnyReachableOverlap(state)) {
    state.phase = "finished";
    state.result = { kind: "finished" };
  }
}

// rules is a snapshot taken at game creation - see sunduchkiRoomManager.js's
// room.rules, host-editable only while the room is still "lobby".
function createGame(playerIds, rules) {
  const n = playerIds.length;
  const deckSize = normalizeDeckSize(rules && rules.deckSize);
  const deck = createDeck(deckSize);
  shuffle(deck);

  const players = playerIds.map((id) => ({ id, hand: [], chests: [], left: false, leftReason: null, leaveRank: null }));
  for (let i = 0; i < 4; i++) {
    for (const p of players) {
      if (deck.length === 0) break;
      p.hand.push(deck.shift());
    }
  }

  return {
    players,
    deck,
    activeSeat: 0,
    phase: "playing",
    totalRanks: ranksForDeckSize(deckSize).length,
    rules: {
      questionTarget: rules && rules.questionTarget === "any" ? "any" : "next",
      deckSize,
    },
    log: [],
    result: null,
  };
}

// The core turn action: seat asks targetSeat for rank. Validates seat is the
// active player, targetSeat is a legal target under rules.questionTarget,
// and seat actually holds >=1 card of rank (no-bluffing). On a hit, ALL of
// the target's matching cards transfer at once (honest reveal - see file
// banner) and any newly-completed chest is laid down immediately; the asker
// keeps the turn. On a miss, the asker draws one card (if the deck has any)
// and the turn passes to the next active seat clockwise.
function applyAsk(state, seat, targetSeat, rank) {
  if (state.phase !== "playing") return err("not-playing");
  if (seat !== state.activeSeat) return err("not-your-turn");
  if (!Number.isInteger(targetSeat) || !isActive(state, targetSeat) || targetSeat === seat) return err("bad-target");
  if (!legalTargets(state, seat).includes(targetSeat)) return err("target-not-allowed");
  if (!Number.isInteger(rank)) return err("bad-request");
  if (!legalAskRanks(state, seat).includes(rank)) return err("rank-not-legal");

  const asker = state.players[seat];
  const target = state.players[targetSeat];
  const matches = target.hand.filter((c) => c.rank === rank);
  const hit = matches.length > 0;

  if (hit) {
    target.hand = target.hand.filter((c) => c.rank !== rank);
    asker.hand.push(...matches);
    const completedChests = layDownCompletedChests(state, seat);
    pushLog(state, { askerSeat: seat, targetSeat, rank, hit: true, revealed: matches, completedChests });
  } else {
    let drawn = null;
    let completedChests = [];
    if (state.deck.length > 0) {
      drawn = state.deck.shift();
      asker.hand.push(drawn);
      completedChests = layDownCompletedChests(state, seat);
    }
    pushLog(state, { askerSeat: seat, targetSeat, rank, hit: false, drawn, completedChests });
    state.activeSeat = nextActiveSeatAfter(state, seat);
  }

  checkGameEnd(state);
  return ok(state);
}

// The only other legal action for the active seat: when they hold no card of
// any still-unclaimed rank (hasLegalAsk is false - in practice, an empty
// hand), they can't ask anything, so they just draw (if the deck has cards)
// and pass. Mirrors classic Go Fish's free draw on an empty hand.
function applyPassEmpty(state, seat) {
  if (state.phase !== "playing") return err("not-playing");
  if (seat !== state.activeSeat) return err("not-your-turn");
  if (hasLegalAsk(state, seat)) return err("must-ask");

  const player = state.players[seat];
  let drawn = null;
  let completedChests = [];
  if (state.deck.length > 0) {
    drawn = state.deck.shift();
    player.hand.push(drawn);
    completedChests = layDownCompletedChests(state, seat);
  }
  pushLog(state, { askerSeat: seat, pass: true, drawn, completedChests });
  state.activeSeat = nextActiveSeatAfter(state, seat);
  checkGameEnd(state);
  return ok(state);
}

// A player leaving/disconnecting-past-grace forfeits their hand outright
// (discarded, not returned to the deck or redistributed - simplest and
// matches durakEngine.js's removePlayer precedent) and earns a leaveRank
// counted DOWN from n in leaving order, same scheme as Durak: whoever left
// FIRST had the most game left to give up on, so they rank worse than
// someone who left later. If only one active seat remains, that seat wins
// outright regardless of chest count (no principled way to rank a forfeit
// win against an interrupted game).
function removePlayer(state, seat, reason) {
  const player = state.players[seat];
  if (!player || player.left) return state;
  player.hand = [];
  player.left = true;
  player.leftReason = reason;
  player.leaveRank = nextLeaveRank(state);

  if (state.phase === "finished") return state;

  const stillActive = activeSeats(state);
  if (stillActive.length <= 1) {
    state.phase = "finished";
    state.result = stillActive.length === 1 ? { kind: "left-early-win", winnerSeat: stillActive[0] } : { kind: "finished" };
    return state;
  }

  if (seat === state.activeSeat) state.activeSeat = nextActiveSeatAfter(state, seat);
  checkGameEnd(state);
  return state;
}

// Turns a finished state into a per-seat finishing order (lower `place` is
// better), for realtime/durakElo.js's computeEloDeltas/computeSingleEloDelta
// (that module's Elo math is fully game-agnostic - see its own header - only
// this placement-building step is Sunduchki-specific, mirroring durakElo.js's
// own buildPlacements but keyed on chest counts instead of Durak's
// finishRank).
//
//  1. A seat that left/timed out keeps its leaveRank (counted down from n -
//     see removePlayer above).
//  2. "left-early-win": the sole survivor is placed at rank 0, better than
//     anyone, including a normal chest-count ranking would have given them.
//  3. Every seat that's still active at the true end is ranked by chest
//     count (most chests = best), ties sharing a place, numbered 1..k - this
//     is always < any leaveRank present (leaveRank only ever occupies the
//     range [n-leftCount+1, n], strictly above k = n-leftCount).
function buildPlacements(state) {
  const n = state.players.length;
  const place = new Array(n).fill(null);

  state.players.forEach((p, seat) => {
    if (p.leaveRank != null) place[seat] = p.leaveRank;
  });

  const result = state.result || {};
  if (result.kind === "left-early-win") {
    place[result.winnerSeat] = 0;
  } else {
    const activeOrder = state.players
      .map((p, seat) => ({ seat, count: p.chests.length }))
      .filter((entry) => place[entry.seat] == null)
      .sort((a, b) => b.count - a.count);
    activeOrder.forEach((entry, i) => {
      place[entry.seat] = i > 0 && entry.count === activeOrder[i - 1].count ? place[activeOrder[i - 1].seat] : i + 1;
    });
  }

  return place.map((p, seat) => ({ seat, place: p }));
}

// The subset of state that's public regardless of viewer: whose turn, deck
// count, per-seat hand COUNTS (never the cards themselves) and chest
// contents (always public - see file banner), plus the rolling public Q&A
// log (capped to the recent tail - see pushLog). serializeForSeat adds the
// viewer's own hand + legal moves on top of this; serializeForSpectator
// sends exactly this and nothing else, same split as durakEngine.js.
function serializePublicState(state) {
  return {
    phase: state.phase,
    activeSeat: state.activeSeat,
    deckCount: state.deck.length,
    totalRanks: state.totalRanks,
    rules: state.rules,
    log: state.log.slice(-50),
    players: state.players.map((p, i) => ({
      seat: i,
      handCount: p.hand.length,
      chests: p.chests.slice(),
      left: p.left,
      leaveRank: p.leaveRank,
    })),
    result: state.result,
  };
}

function serializeForSpectator(state) {
  return serializePublicState(state);
}

function serializeForSeat(state, seat) {
  const me = state.players[seat];
  return {
    ...serializePublicState(state),
    you: { seat, hand: me ? me.hand.slice() : [] },
    legal: {
      canAsk: state.phase === "playing" && seat === state.activeSeat && hasLegalAsk(state, seat),
      canPass: state.phase === "playing" && seat === state.activeSeat && !hasLegalAsk(state, seat),
      askRanks: legalAskRanks(state, seat),
      targets: legalTargets(state, seat),
    },
  };
}

module.exports = {
  SUITS,
  createDeck,
  normalizeDeckSize,
  shuffle,
  createGame,
  applyAsk,
  applyPassEmpty,
  removePlayer,
  buildPlacements,
  serializeForSeat,
  serializeForSpectator,
  legalAskRanks,
  legalTargets,
  hasLegalAsk,
  activeSeats,
  isActive,
  claimedRanks,
};
