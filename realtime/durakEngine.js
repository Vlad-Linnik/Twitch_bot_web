// Pure, I/O-free N-player (2-6) classic "podkidnoy" Durak rules engine. No ws/
// Mongo/Express references on purpose - this is the one piece of the
// multiplayer feature that gets real node:test coverage (see
// tests/durakEngine.test.js), unlike the single-player 2-player engine
// (public/js/games/durak.js) which is DOM-coupled and could only be verified
// with a hand-rolled harness. realtime/durakRoomManager.js is the only caller;
// it owns all I/O (sockets, Mongo) and trusts nothing from the network without
// routing it through the validation here.
//
// Unlike the single-player engine, real multiplayer Durak lets ANY
// non-defending, active player throw in cards, not just the attacker, and
// several undefended cards can sit on the table at once before the defender
// answers any of them. The bout is modeled as alternating "wave" and "defend"
// phases:
//   open   - the attacker plays the bout's first card (mandatory, table was
//            empty). Transitions straight to "wave".
//   wave   - every active player except the defender may add ONE card whose
//            rank already appears on the table, or explicitly pass. The wave
//            closes when every eligible seat has passed (or currently holds no
//            legal card) or the cap is reached. If nothing new was added this
//            wave, the bout resolves as "beaten" (nothing left to defend). If
//            something WAS added, play moves to "defend".
//   defend - the defender must resolve every undefended table card: beat each
//            one (any order, any valid card) or Take (pull the whole table
//            into their hand, ending the bout as "taken"). Fully beating
//            everything loops back to "wave" for another round of throw-ins.
// The attacker for the NEXT bout is always the seat clockwise of whoever just
// defended, whether they beat the wave or took it - the single-player engine's
// "same attacker re-attacks after a take" is just the N=2 degenerate case of
// this one rule (there's nowhere else to rotate to with only 2 seats).
"use strict";

const SUITS = ["S", "H", "D", "C"];

// A 36-card deck (ranks 6-14) dealt 6-each to 6 players leaves ZERO reserve
// cards (36 - 6*6 = 0) - no trump reveal, no redraws, structurally broken.
// Extend to a 52-card deck (ranks 2-14) only at exactly 6 players (52-36=16
// reserve) - a standard, common house-rule for large Durak tables. 2-5 player
// rooms stay on the classic 36-card deck, unchanged from single-player.
function createDeck(playerCount) {
  const startRank = playerCount >= 6 ? 2 : 6;
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = startRank; rank <= 14; rank++) cards.push({ suit, rank });
  }
  return cards;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = cards[i];
    cards[i] = cards[j];
    cards[j] = tmp;
  }
}

function beats(defCard, atkCard, trumpSuit) {
  if (defCard.suit === atkCard.suit) return defCard.rank > atkCard.rank;
  return defCard.suit === trumpSuit && atkCard.suit !== trumpSuit;
}

function findCardIndex(hand, card) {
  return hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
}

function takeCardByValue(hand, card) {
  const i = findCardIndex(hand, card);
  if (i < 0) return null;
  return hand.splice(i, 1)[0];
}

function isActive(state, seat) {
  const p = state.players[seat];
  return !!p && !p.out && !p.left;
}

function activeSeats(state) {
  return state.players.map((_, i) => i).filter((i) => isActive(state, i));
}

// Next active seat clockwise of `seat` (wrapping); falls back to `seat`
// itself if no other active seat exists (the game should already be over by
// then - this is a defensive fallback, not a reachable path in normal play).
function nextActiveSeatAfter(state, seat) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const candidate = (seat + i) % n;
    if (isActive(state, candidate)) return candidate;
  }
  return seat;
}

function seatDistanceFrom(from, to, n) {
  return ((to - from) % n + n) % n;
}

function tableRanks(state) {
  const ranks = new Set();
  for (const pair of state.table) {
    ranks.add(pair.attack.rank);
    if (pair.defense) ranks.add(pair.defense.rank);
  }
  return ranks;
}

function isEligibleWaveSeat(state, seat) {
  if (state.phase !== "wave") return false;
  if (seat === state.defenderSeat) return false;
  return isActive(state, seat);
}

function legalThrowInCards(state, seat) {
  if (!isEligibleWaveSeat(state, seat)) return [];
  // Rules.allowThrowIns === false is the classic "неподкидной" variant: only
  // the attacker's mandatory opening card is ever allowed, nobody (including
  // the attacker) can add more. Returning [] here for every seat is
  // sufficient on its own - checkWaveClosure() already resolves a wave with
  // no legal cards and nothing added immediately (straight to "defend" right
  // after open, straight to resolveBout("beaten") right after a full defend),
  // no other function needs to know about the rule.
  if (state.rules && state.rules.allowThrowIns === false) return [];
  if (state.table.length >= state.boutCap) return [];
  const ranks = tableRanks(state);
  return state.players[seat].hand.filter((c) => ranks.has(c.rank));
}

function legalDefendCards(state, tableIndex) {
  if (state.phase !== "defend") return [];
  const pair = state.table[tableIndex];
  if (!pair || pair.defense) return [];
  return state.players[state.defenderSeat].hand.filter((c) => beats(c, pair.attack, state.trumpSuit));
}

// "Перевод" (transfer): rules.allowTransfers-gated. Instead of defending, the
// defender may lay down a card of the SAME rank as the table (any suit,
// including trump - a trump card matching rank is a genuine dual option, see
// applyTransfer's comment) and hand the whole undefended pile - plus their
// new card - to the next active seat, who becomes the new defender. Only
// legal as the very first response to a bout: once even one card has been
// defended, every remaining undefended card is still open to the SAME
// transfer opportunity in real rules, but this engine (like most online
// implementations) simplifies to "all-or-nothing before any defending
// starts" - once the defender commits to beating even one card, they can no
// longer transfer the rest. Every undefended card on the table necessarily
// shares one rank at this point (see the file banner's wave-phase comment:
// throw-ins can only ever match a rank already present), so state.table[0]'s
// rank represents all of them.
function canTransfer(state, seat) {
  if (!state.rules || !state.rules.allowTransfers) return false;
  if (state.phase !== "defend") return false;
  if (seat !== state.defenderSeat) return false;
  if (!state.table.length) return false;
  if (state.table.some((p) => p.defense)) return false;
  if (state.table.length >= state.boutCap) return false;
  // House rule: the very first bout of the game can never be transferred.
  if (state.boutIndex <= 1) return false;
  // The seat about to inherit the pile (applyTransfer hands it to
  // nextActiveSeatAfter(oldDefender)) must be able to cover every card
  // already on the table PLUS the card this transfer adds - otherwise a
  // transfer could hand someone a bout they structurally can't ever finish.
  const nextSeat = nextActiveSeatAfter(state, seat);
  if (nextSeat === seat) return false;
  if (state.players[nextSeat].hand.length < state.table.length + 1) return false;
  return true;
}

function legalTransferCards(state, seat) {
  if (!canTransfer(state, seat)) return [];
  const rank = state.table[0].attack.rank;
  return state.players[seat].hand.filter((c) => c.rank === rank);
}

// Seats that currently owe an active decision - i.e. whose per-player time
// budget should be ticking right now (see realtime/durakClock.js, which owns
// the actual wall-clock bookkeeping; this stays pure/derived-from-state like
// the rest of this file, no Date.now() here). "open"/"defend" are single-seat
// turns; "wave" is genuinely simultaneous - every seat checkWaveClosure is
// still waiting on (hasn't passed, and actually has a legal card to throw in
// - anyone else is already auto-settled and owes nothing) is "on the clock"
// at once, same as several players sitting at a real table all deciding
// whether to throw in before the defender is allowed to act.
function runningSeats(state) {
  // "beaten-pause" (see checkWaveClosure) is a display-only hold before the
  // discard actually happens - nobody owes a decision during it, so nobody's
  // clock should drain for it either, on either side of the table.
  if (state.phase === "beaten-pause") return [];
  if (state.phase === "open") return isActive(state, state.attackerSeat) ? [state.attackerSeat] : [];
  if (state.phase === "defend") return isActive(state, state.defenderSeat) ? [state.defenderSeat] : [];
  if (state.phase === "wave") {
    return activeSeats(state).filter(
      (seat) =>
        isEligibleWaveSeat(state, seat) && !state.passedSeats.has(seat) && legalThrowInCards(state, seat).length > 0
    );
  }
  return [];
}

function ok(state) {
  return { ok: true, state };
}
function err(error) {
  return { ok: false, error };
}

function startNewBout(state, attackerSeat) {
  state.attackerSeat = attackerSeat;
  state.defenderSeat = nextActiveSeatAfter(state, attackerSeat);
  state.table = [];
  state.boutCap = null;
  state.passedSeats = new Set();
  state.addedThisWave = false;
  state.phase = "open";
  // 1-based - the very first bout of the game is boutIndex 1, used by
  // canTransfer to forbid перевод on it (see that function's comment).
  state.boutIndex = (state.boutIndex || 0) + 1;
}

// Every player who has emptied their hand once the reserve is gone is "out"
// (safe) and removed from rotation but kept in finishing order. Only ever
// meaningful once deck.length === 0 - while the reserve still has cards, a
// momentarily-empty hand just means "will refill at the next draw-up".
function nextFinishRank(state) {
  const used = state.players.map((p) => p.finishRank).filter((r) => r != null);
  return used.length ? Math.max(...used) + 1 : 1;
}

function checkOutPlayers(state) {
  if (state.deck.length > 0) return;
  const beforeActive = activeSeats(state);
  const justFinished = beforeActive.filter((s) => state.players[s].hand.length === 0);
  for (const s of justFinished) {
    state.players[s].out = true;
    state.players[s].finishRank = nextFinishRank(state);
  }
  const stillActive = activeSeats(state);
  if (stillActive.length === 0) {
    state.phase = "finished";
    state.result = { kind: "draw", seats: justFinished };
  } else if (stillActive.length === 1) {
    state.phase = "finished";
    state.result = { kind: "durak", loserSeat: stillActive[0] };
  }
}

function drawUpPhase(state, orderedSeats) {
  for (const seat of orderedSeats) {
    const hand = state.players[seat].hand;
    while (hand.length < 6 && state.deck.length > 0) hand.push(state.deck.shift());
  }
}

// Attacker first, then everyone else clockwise from the attacker, defender
// drawn last - a deterministic approximation of "defender draws last" that
// doesn't require tracking the exact chronological throw-in order.
function drawOrderBeaten(state, attackerSeat, defenderSeat) {
  const n = state.players.length;
  const middle = activeSeats(state)
    .filter((s) => s !== attackerSeat && s !== defenderSeat)
    .sort((a, b) => seatDistanceFrom(attackerSeat, a, n) - seatDistanceFrom(attackerSeat, b, n));
  return [attackerSeat, ...middle, defenderSeat];
}

// Attacker first, then everyone else clockwise, EXCLUDING the taker (they
// already have plenty, and keep attacking again next bout per the unified
// rotation rule).
function drawOrderTaken(state, attackerSeat, takerSeat) {
  const n = state.players.length;
  return activeSeats(state)
    .filter((s) => s !== takerSeat)
    .sort((a, b) => seatDistanceFrom(attackerSeat, a, n) - seatDistanceFrom(attackerSeat, b, n));
}

function resolveBout(state, kind) {
  const oldAttacker = state.attackerSeat;
  const oldDefender = state.defenderSeat;
  if (kind === "beaten") {
    state.table = [];
    drawUpPhase(state, drawOrderBeaten(state, oldAttacker, oldDefender));
  } else {
    const defenderHand = state.players[oldDefender].hand;
    for (const pair of state.table) {
      defenderHand.push(pair.attack);
      if (pair.defense) defenderHand.push(pair.defense);
    }
    state.table = [];
    drawUpPhase(state, drawOrderTaken(state, oldAttacker, oldDefender));
  }
  checkOutPlayers(state);
  if (state.phase === "finished") return;
  // "Beaten" and "taken" hand the attack to different seats - a defender who
  // beat everything becomes the attacker THEMSELVES next bout (real rule,
  // matches the single-player engine's afterBout("beaten") swap and this
  // repo's own games.durakMultiplayer.mpRule2 copy: "Defended everything on
  // the table - you become the attacker"). Only a "taken" bout skips the
  // taker and hands the attack to the seat after them (mpRule3: "Took the
  // cards - the same attacker goes again", which for N>2 generalizes to
  // "attack passes to the next seat after the taker"). Falls back to the
  // next active seat after the preferred one if that seat just went "out"
  // (checkOutPlayers above may have emptied their hand with no deck left) -
  // an out player can never be assigned as the next attacker.
  const preferredAttacker = kind === "beaten" ? oldDefender : nextActiveSeatAfter(state, oldDefender);
  const nextAttacker = isActive(state, preferredAttacker) ? preferredAttacker : nextActiveSeatAfter(state, preferredAttacker);
  startNewBout(state, nextAttacker);
}

// Closes the current wave once every eligible seat has passed or has nothing
// legal to add, or the cap is hit. Called immediately after every open/
// throw-in/pass/defend-completes so a wave with zero eligible seats (or an
// already-satisfied cap) resolves instantly without waiting on a message that
// will never come - this is what makes N=2 degenerate correctly into "only
// the attacker can throw in", since the defender is the only other seat and
// is always excluded from eligibility.
function checkWaveClosure(state) {
  if (state.phase !== "wave") return;
  const eligible = activeSeats(state).filter((s) => s !== state.defenderSeat);
  const capReached = state.table.length >= state.boutCap;
  const allSettled =
    capReached || eligible.every((s) => state.passedSeats.has(s) || legalThrowInCards(state, s).length === 0);
  if (!allSettled) return;
  if (state.addedThisWave) {
    state.phase = "defend";
  } else {
    // Don't discard immediately - hold everything exactly as it is (table,
    // attacker/defender, hands) for realtime/durakRoomManager.js's 4s
    // display pause, so both sides get a beat to see what was beaten before
    // it actually clears. finishBeatenPause() below does the real work once
    // that pause elapses.
    state.phase = "beaten-pause";
  }
}

// Called by durakRoomManager.js once its 4s post-beaten pause elapses.
// No-op if the pause was already short-circuited (e.g. removePlayer() reset
// the bout early because the attacker/defender left mid-pause).
function finishBeatenPause(state) {
  if (state.phase !== "beaten-pause") return;
  resolveBout(state, "beaten");
}

// rules is a snapshot taken at game creation - see durakRoomManager.js's
// room.rules, host-editable only while the room is still "lobby". Once a game
// exists it's fixed for the rest of that game, same as trumpSuit.
function createGame(playerIds, rules) {
  const n = playerIds.length;
  const deck = createDeck(n);
  shuffle(deck);
  const trumpCard = deck.pop();
  const trumpSuit = trumpCard.suit;
  deck.push(trumpCard); // bottom of the reserve - drawn last, same as a real deck

  const players = playerIds.map((id) => ({ id, hand: [], out: false, left: false, finishRank: null }));
  for (let i = 0; i < 6; i++) {
    for (const p of players) {
      if (deck.length === 0) break;
      p.hand.push(deck.shift());
    }
  }

  const state = {
    players,
    deck,
    trumpSuit,
    trumpCard,
    table: [],
    attackerSeat: 0,
    defenderSeat: 1 % n,
    boutCap: null,
    passedSeats: new Set(),
    addedThisWave: false,
    phase: "open",
    result: null,
    rules: {
      allowThrowIns: !(rules && rules.allowThrowIns === false),
      allowTransfers: !!(rules && rules.allowTransfers === true),
    },
  };

  let firstAttacker = 0;
  let bestRank = Infinity;
  let anyTrump = false;
  players.forEach((p, i) => {
    const trumps = p.hand.filter((c) => c.suit === trumpSuit);
    if (!trumps.length) return;
    const lowest = trumps.reduce((a, b) => (a.rank < b.rank ? a : b));
    if (lowest.rank < bestRank) {
      bestRank = lowest.rank;
      firstAttacker = i;
      anyTrump = true;
    }
  });
  if (!anyTrump) firstAttacker = Math.floor(Math.random() * n);

  startNewBout(state, firstAttacker);
  return state;
}

function applyOpen(state, seat, card) {
  if (state.phase !== "open") return err("not-open-phase");
  if (seat !== state.attackerSeat) return err("not-attacker");
  const taken = takeCardByValue(state.players[seat].hand, card);
  if (!taken) return err("not-in-hand");
  state.table.push({ attack: taken, defense: null });
  state.boutCap = Math.min(6, state.players[state.defenderSeat].hand.length);
  state.phase = "wave";
  state.addedThisWave = true;
  state.passedSeats = new Set();
  checkWaveClosure(state);
  return ok(state);
}

function applyThrowIn(state, seat, card) {
  if (!isEligibleWaveSeat(state, seat)) return err("not-eligible");
  if (state.table.length >= state.boutCap) return err("cap-reached");
  if (!tableRanks(state).has(card.rank)) return err("rank-not-on-table");
  const taken = takeCardByValue(state.players[seat].hand, card);
  if (!taken) return err("not-in-hand");
  state.table.push({ attack: taken, defense: null });
  state.addedThisWave = true;
  state.passedSeats = new Set();
  checkWaveClosure(state);
  return ok(state);
}

function applyPassThrowIn(state, seat) {
  if (!isEligibleWaveSeat(state, seat)) return err("not-eligible");
  state.passedSeats.add(seat);
  checkWaveClosure(state);
  return ok(state);
}

function applyDefend(state, seat, tableIndex, card) {
  if (state.phase !== "defend") return err("not-defend-phase");
  if (seat !== state.defenderSeat) return err("not-defender");
  const pair = state.table[tableIndex];
  if (!pair || pair.defense) return err("invalid-index");
  const handCard = state.players[seat].hand.find((c) => c.suit === card.suit && c.rank === card.rank);
  if (!handCard) return err("not-in-hand");
  if (!beats(handCard, pair.attack, state.trumpSuit)) return err("illegal-beat");
  takeCardByValue(state.players[seat].hand, card);
  pair.defense = handCard;
  const allDefended = state.table.every((p) => p.defense);
  if (allDefended) {
    state.phase = "wave";
    state.addedThisWave = false;
    state.passedSeats = new Set();
    checkWaveClosure(state);
  }
  return ok(state);
}

// A card matching the table's rank can be BOTH a legal defend (a trump beats
// any non-trump attack card outright, and a trump happens to also match rank
// here) AND a legal transfer at once - callers (realtime/durakRoomManager.js,
// which routes "defend" vs "transfer" as distinct message types from the
// client) decide which one the player meant; the engine itself makes no
// assumption and just validates whichever was actually requested.
function applyTransfer(state, seat, card) {
  if (!canTransfer(state, seat)) return err("cannot-transfer");
  const rank = state.table[0].attack.rank;
  if (card.rank !== rank) return err("rank-mismatch");
  const taken = takeCardByValue(state.players[seat].hand, card);
  if (!taken) return err("not-in-hand");
  const oldDefender = state.defenderSeat;
  state.table.push({ attack: taken, defense: null });
  // The old defender is safe from THIS bout and rejoins the wave as a regular
  // eligible seat (isEligibleWaveSeat only ever excludes the CURRENT
  // defenderSeat, which just changed) - the new defender is whoever's next.
  state.defenderSeat = nextActiveSeatAfter(state, oldDefender);
  state.phase = "wave";
  state.addedThisWave = true;
  state.passedSeats = new Set();
  checkWaveClosure(state);
  return ok(state);
}

function applyTake(state, seat) {
  if (state.phase !== "defend") return err("not-defend-phase");
  if (seat !== state.defenderSeat) return err("not-defender");
  resolveBout(state, "taken");
  return ok(state);
}

// A player leaving/timing out forfeits their hand (removed from play, not
// redistributed - keeps the bookkeeping simple for what's already an edge
// case, not the core gameplay loop). If they were structurally load-bearing
// for the bout in progress (attacker or defender), the whole current table is
// discarded and a fresh bout starts from the seat after them - simpler and
// more robust than trying to preserve partial wave/defend state around a
// departed participant. A bystander leaving mid-wave doesn't disturb the
// bout; their cards already on the table (if any) just stay there, still
// valid for the defender to answer.
function removePlayer(state, seat, reason) {
  const player = state.players[seat];
  if (!player || player.left || player.out) return state;
  player.hand = [];
  player.left = true;
  player.leftReason = reason;

  if (state.phase === "finished") return state;

  const stillActive = activeSeats(state);
  if (stillActive.length <= 1) {
    state.phase = "finished";
    // loserSeat/reason let the client report what actually happened and to
    // whom - `seat`/`reason` here are exactly the player/cause that just
    // triggered this finish (durakRoomManager.js passes "clock" for a
    // move-timer forfeit, "leave"/"disconnect"/"timeout" otherwise), which
    // was previously discarded, leaving every client to show the same
    // generic "opponent left, you win" text regardless of who they were or
    // why the game actually ended.
    state.result =
      stillActive.length === 1
        ? { kind: "left-early-win", winnerSeat: stillActive[0], loserSeat: seat, reason }
        : { kind: "draw", seats: [] };
    return state;
  }

  if (seat === state.attackerSeat || seat === state.defenderSeat) {
    state.table = [];
    const nextAttacker = nextActiveSeatAfter(state, seat);
    startNewBout(state, nextAttacker);
  }
  return state;
}

// The subset of state that's public regardless of viewer: table, trump, deck
// count, per-seat hand COUNTS (never the cards themselves) and finishing
// state. serializeForSeat adds the viewer's own hand + legal-move hints on
// top of this; serializeForSpectator (durakRoomManager.js's watchRoom path)
// sends exactly this and nothing else - a spectator gets the same visibility
// as someone looking at the table from outside, never a seated player's hand.
function serializePublicState(state) {
  return {
    phase: state.phase,
    attackerSeat: state.attackerSeat,
    defenderSeat: state.defenderSeat,
    trumpSuit: state.trumpSuit,
    trumpCard: state.deck.length > 0 ? state.trumpCard : null,
    deckCount: state.deck.length,
    rules: state.rules,
    boutCap: state.boutCap,
    table: state.table.map((p) => ({ attack: p.attack, defense: p.defense })),
    players: state.players.map((p, i) => ({
      seat: i,
      handCount: p.hand.length,
      out: p.out,
      left: p.left,
      finishRank: p.finishRank,
      // Public, not hand-revealing (passing just means "added nothing this
      // wave") - lets a viewer's per-seat role label (durak-multiplayer.js)
      // show "passed" instead of leaving a wave participant unlabeled.
      // Meaningless outside "wave" (passedSeats is reset at the start of
      // every wave - see checkWaveClosure/applyOpen/applyDefend/applyTransfer).
      passed: state.passedSeats.has(i),
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
      canOpen: state.phase === "open" && seat === state.attackerSeat,
      canThrowIn: legalThrowInCards(state, seat),
      canPass: isEligibleWaveSeat(state, seat) && !state.passedSeats.has(seat),
      canTake: state.phase === "defend" && seat === state.defenderSeat,
      canTransfer: canTransfer(state, seat),
      transferCards: legalTransferCards(state, seat),
      defendable:
        state.phase === "defend" && seat === state.defenderSeat
          ? state.table
              .map((p, i) => ({ index: i, options: legalDefendCards(state, i) }))
              .filter((entry) => !state.table[entry.index].defense)
          : [],
    },
  };
}

module.exports = {
  createDeck,
  shuffle,
  beats,
  createGame,
  applyOpen,
  applyThrowIn,
  applyPassThrowIn,
  applyDefend,
  applyTransfer,
  applyTake,
  removePlayer,
  serializeForSeat,
  serializeForSpectator,
  legalThrowInCards,
  legalDefendCards,
  canTransfer,
  legalTransferCards,
  activeSeats,
  isActive,
  runningSeats,
  finishBeatenPause,
};
