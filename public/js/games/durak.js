// /games/durak's "play vs computer" section - classic 2-player "podkidnoy"
// (throw-in) Durak against a simple AI, 36-card deck. Cards are plain DOM (no
// images), built from {suit, rank} objects - same "no external assets"
// approach as game2048.js's tiles. Fully client-side, no server state: the win
// count (readWins/writeWins below) only ever lives in localStorage - the
// site's Durak leaderboard now ranks online (multiplayer) wins only, credited
// server-side by realtime/durakRoomManager.js, so a vs-computer win is never
// submitted anywhere.
//
// Rule simplification: real Durak lets an attacker drop several undefended
// cards on the table before the defender responds to any of them. Here the
// defender always resolves the most recent attack card before the attacker
// can add another - functionally equivalent in a 1v1 game (nobody else can
// throw in while the defender is mid-response) and much simpler to drive by
// click. Throw-ins may still match the rank of ANY card already on the table,
// and are capped at 6 total per bout (and at the defender's hand size at the
// moment the bout started), same as the real rules.
(function () {
  "use strict";

  const boardEl = document.getElementById("durak-board");
  if (!boardEl) return;

  const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const WINS_KEY = "durakWins";

  const opponentHandEl = document.getElementById("durak-opponent-hand");
  const deckEl = document.getElementById("durak-deck");
  const deckCountEl = document.getElementById("durak-deck-count");
  const trumpLabelEl = document.getElementById("durak-trump-label");
  const tableEl = document.getElementById("durak-table");
  const statusEl = document.getElementById("durak-status");
  const playerHandEl = document.getElementById("durak-player-hand");
  const takeBtn = document.getElementById("durak-take-btn");
  const bitoBtn = document.getElementById("durak-bito-btn");
  const winsEl = document.getElementById("durak-wins");
  const newGameBtn = document.getElementById("durak-newgame");

  const overlayEl = document.getElementById("durak-overlay");
  const overlayTitleEl = document.getElementById("durak-overlay-title");
  const overlayWinsEl = document.getElementById("durak-overlay-wins");
  const overlayButtonEl = document.getElementById("durak-overlay-button");

  function readWins() {
    try {
      return parseInt(localStorage.getItem(WINS_KEY), 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  function writeWins(value) {
    try {
      localStorage.setItem(WINS_KEY, String(value));
    } catch (_) {
      /* private mode etc. - the count just won't persist */
    }
  }

  // --- Sound -------------------------------------------------------------
  // Same pattern as pipe-dodger.js/falling-blocks.js: cloneNode() per play so
  // rapid-fire plays (e.g. a Take pulling several cards at once) can overlap
  // instead of cutting each other off.

  const SOUND_BASE = "/sounds/games/durak/";
  const SOUNDS = {
    slide: new Audio(SOUND_BASE + "card_slide.wav"),
    shuffle: new Audio(SOUND_BASE + "shuffle.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

  // Stagger between each card's deal-in animation start, in ms - see
  // renderPlayerHand()/the opponent-hand entrance block in renderAll(). Tuned
  // so the full 6-card deal (5 * stagger + the 260ms flip itself) roughly
  // covers shuffle.wav's ~0.98s runtime - too fast and the animation finishes
  // while the sound is still audibly playing.
  const DEAL_STAGGER_MS = 130;

  function playSound(name) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume;
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

  // --- Card model --------------------------------------------------------------

  function rankLabel(rank) {
    return RANK_LABEL[rank] || String(rank);
  }

  function isRed(suit) {
    return suit === "H" || suit === "D";
  }

  // Fills an existing wrapper div with a face-up card's markup. Split out of
  // buildCardEl() so the identity-tracked path below (getTrackedFaceEl) can
  // repaint the SAME persistent element across renders instead of building a
  // fresh one - reusing the node is what lets the FLIP animation in runFlips()
  // find "where this card used to be" via a plain getBoundingClientRect() diff.
  function paintFaceInto(el, card, extraClass) {
    el.className =
      "durak-card relative w-14 h-20 rounded-md bg-neutral-100 border border-neutral-300 shadow-sm shrink-0" +
      (extraClass ? " " + extraClass : "");
    el.replaceChildren();
    const colorClass = isRed(card.suit) ? "text-red-600" : "text-neutral-900";
    const label = rankLabel(card.rank);
    const symbol = SUIT_SYMBOL[card.suit];
    const topLeft = document.createElement("span");
    topLeft.className = "absolute top-1 left-1.5 text-xs font-bold leading-tight " + colorClass;
    topLeft.textContent = label;
    const bottomRight = document.createElement("span");
    bottomRight.className = "absolute bottom-1 right-1.5 text-xs font-bold leading-tight rotate-180 " + colorClass;
    bottomRight.textContent = label;
    const center = document.createElement("span");
    center.className = "absolute inset-0 grid place-items-center text-xl " + colorClass;
    center.textContent = symbol;
    el.append(topLeft, bottomRight, center);
  }

  function buildCardEl(card, extraClass) {
    const el = document.createElement("div");
    paintFaceInto(el, card, extraClass);
    return el;
  }

  // --- Identity-tracked cards (for movement animation) ----------------------
  // The deck and the opponent's hand are rendered as anonymous, interchangeable
  // backs (buildCardBackEl above, fresh nodes every render - nobody needs to
  // track a hidden card's real identity). The player's hand and the table are
  // the opposite: the same physical card can visibly move between them for the
  // rest of the game (hand -> table on attack/defense, table -> hand on Take,
  // hand -> hand on a sort reshuffle), so those two contexts share one
  // persistent DOM node per card, keyed by suit+rank (unique in a 36-card
  // deck - no separate id field needed). Reusing the node instead of rebuilding
  // it is what makes the FLIP trick in runFlips() possible: it can only measure
  // "before" and "after" positions of the SAME element.
  let cardEls; // id -> element, reset per game in dealNewGame()
  let previouslyVisibleIds; // ids in cardEls that were on-screen last render
  let firstRenderOfGame;
  let previousAiHandCount;

  function cardId(card) {
    return card.suit + card.rank;
  }

  function getTrackedFaceEl(card, extraClass) {
    const id = cardId(card);
    let el = cardEls.get(id);
    if (!el) {
      el = document.createElement("div");
      cardEls.set(id, el);
    }
    paintFaceInto(el, card, extraClass);
    return el;
  }

  // --- FLIP movement animation -----------------------------------------------
  // Classic FLIP (First-Last-Invert-Play): a tracked card's DOM node is moved
  // to its new position/parent instantly (renderTable/renderPlayerHand below),
  // then this offsets it right back with a transform and animates that offset
  // down to zero - it LOOKS like the card slid from A to B, but no layout
  // measurement happens mid-transition, so it's cheap and jank-free even while
  // hand/table content keeps reflowing around it.
  function beginFlip(el, fromRect) {
    const toRect = el.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
    el.style.transition = "none";
    el.style.transform = "translate(" + dx + "px, " + dy + "px)";
    return el;
  }

  // moves: [{el, fromRect, delay}]. Batches the "set the inverted transform"
  // step for every card before the single shared reflow + rAF, so simultaneous
  // moves (e.g. a Take pulling 6+ cards back into hand at once) animate in
  // lockstep instead of staggering by a frame each. An optional per-move delay
  // (ms) staggers the *start* of the un-invert instead - used for dealing, so
  // cards visibly arrive one after another rather than all sliding in at once.
  function runFlips(moves) {
    const animating = [];
    for (const move of moves) {
      const el = beginFlip(move.el, move.fromRect);
      if (el) animating.push({ el, delay: move.delay || 0 });
    }
    if (!animating.length) return;
    void boardEl.offsetHeight; // force one shared reflow before un-inverting
    requestAnimationFrame(() => {
      for (const { el, delay } of animating) {
        el.style.transition =
          "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)" + (delay ? " " + delay + "ms" : "");
        el.style.transform = "";
        el.addEventListener(
          "transitionend",
          function clearInlineTransition(e) {
            if (e.propertyName !== "transform" || e.target !== el) return;
            el.style.transition = "";
          },
          { once: true }
        );
      }
    });
  }

  // --- Exit animation (beaten / taken-by-opponent cards) ----------------------
  // A tracked card that leaves the pool without landing back in playerHand or
  // table - beaten to the discard pile, or taken into the AI's anonymous hand -
  // used to just be removed instantly. This reparents it onto the board at its
  // last known screen position and animates it out instead.
  //
  // towardRect, if given, is the rect to animate toward (e.g. the opponent
  // hand, when the AI takes the table) - the card shrinks into that spot
  // instead of leaving the board. With no towardRect (a genuinely beaten/
  // discarded card - nobody keeps it), it slides off to the right instead.
  function animateCardExit(el, fromRect, towardRect) {
    if (!fromRect) {
      el.remove();
      return;
    }
    const boardRect = boardEl.getBoundingClientRect();
    el.style.transition = "none";
    el.style.transform = "";
    el.style.position = "absolute";
    el.style.margin = "0";
    el.style.left = fromRect.left - boardRect.left + "px";
    el.style.top = fromRect.top - boardRect.top + "px";
    el.style.zIndex = "5";
    el.style.opacity = "1";
    boardEl.appendChild(el);
    void el.offsetHeight; // force layout before animating, same reason as runFlips
    const dx = towardRect ? towardRect.left + towardRect.width / 2 - (fromRect.left + fromRect.width / 2) : 160;
    const dy = towardRect ? towardRect.top + towardRect.height / 2 - (fromRect.top + fromRect.height / 2) : 0;
    requestAnimationFrame(() => {
      el.style.transition = "transform 320ms ease-in, opacity 280ms ease-in 40ms";
      el.style.transform = "translate(" + dx + "px, " + dy + "px) scale(0.6)";
      el.style.opacity = "0";
    });
    el.addEventListener(
      "transitionend",
      function removeAfterExit(e) {
        if (e.propertyName !== "transform") return;
        el.remove();
      },
      { once: true }
    );
  }

  // --- Action toasts -----------------------------------------------------------
  // A one-line "what just happened" banner over the board. Card movement is now
  // animated, but a couple of state changes have no visual footprint of their
  // own (the table clearing looks identical whether it was cleanly beaten or
  // the defender gave up and took everything) - this disambiguates them.
  let toastEl = null;
  let toastTimer = null;

  function showActionToast(text) {
    if (!text) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className =
        "absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-neutral-900/90 border border-neutral-700 text-xs text-neutral-200 opacity-0 pointer-events-none transition-opacity duration-200 z-10";
      boardEl.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 1600);
  }

  // buildCardEl()'s own class always includes "relative" (its rank/suit label
  // spans are absolutely positioned within it) - appending "absolute" to that
  // same class list doesn't work: Tailwind's compiled stylesheet order makes
  // "relative" win the position: cascade regardless of what order the classes
  // were authored in, so the card silently stays in normal flow instead of
  // being positioned. Wrapping it in a plain, unrelated element for the
  // "absolute" side avoids the two ever landing on the same node.
  function positionAbsolute(el, extraClass) {
    const wrap = document.createElement("div");
    wrap.className = "absolute w-14 h-20" + (extraClass ? " " + extraClass : "");
    wrap.appendChild(el);
    return wrap;
  }

  // sizeClass is required, not optional - see durak-multiplayer.js's copy of
  // this same function for why a hardcoded default size here would silently
  // beat a caller's override instead of composing with it.
  function buildCardBackEl(sizeClass, extraClass) {
    const el = document.createElement("div");
    el.className =
      sizeClass + " rounded-md border-2 border-purple-950 shrink-0 bg-purple-800 ring-1 ring-inset ring-purple-500/40" +
      (extraClass ? " " + extraClass : "");
    return el;
  }

  function buildDeck() {
    const suits = ["S", "H", "D", "C"];
    const cards = [];
    for (const s of suits) for (let r = 6; r <= 14; r++) cards.push({ suit: s, rank: r });
    return cards;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  function removeCard(hand, card) {
    const i = hand.indexOf(card);
    if (i >= 0) hand.splice(i, 1);
  }

  // --- Game state ----------------------------------------------------------

  let deck, trumpSuit, trumpCard, playerHand, aiHand, table;
  let attacker, defender, boutCap, over, resultKind, wins, gameId;
  // Set by afterBout() just before a table clear, read (and left as-is) by the
  // exit-animation removal loop in renderAll() - see afterBout()'s comment.
  let pendingExitTarget = "discard";
  // True while a "beaten" bout is holding the table on screen before the
  // discard actually happens - see afterBout(). Blocks all input via
  // currentActor() so nobody can act on cards that are about to vanish.
  let resolving = false;

  function sortHand(hand) {
    hand.sort((a, b) => {
      const at = a.suit === trumpSuit ? 1 : 0;
      const bt = b.suit === trumpSuit ? 1 : 0;
      if (at !== bt) return at - bt;
      if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
      return a.rank - b.rank;
    });
  }

  function beats(def, atk) {
    if (def.suit === atk.suit) return def.rank > atk.rank;
    return def.suit === trumpSuit && atk.suit !== trumpSuit;
  }

  // Every rank currently on the table (attack or defense side) is a valid
  // throw-in rank, capped at 6 cards and at the defender's hand size when the
  // bout started.
  function legalThrowIns(hand) {
    if (!table.length || table.length >= boutCap) return [];
    const ranks = new Set();
    table.forEach((pair) => {
      ranks.add(pair.attack.rank);
      if (pair.defense) ranks.add(pair.defense.rank);
    });
    return hand.filter((c) => ranks.has(c.rank));
  }

  function currentActor() {
    if (over || resolving) return null;
    if (table.length && table[table.length - 1].defense === null) return defender;
    return attacker;
  }

  function pushAttackCard(card, fromHand) {
    if (table.length === 0) {
      boutCap = Math.min(6, (defender === "player" ? playerHand : aiHand).length);
    }
    playSound("slide");
    table.push({ attack: card, defense: null });
    removeCard(fromHand, card);
  }

  function drawUpTo6(who) {
    const hand = who === "player" ? playerHand : aiHand;
    while (hand.length < 6 && deck.length > 0) hand.push(deck.shift());
    if (who === "player") sortHand(playerHand);
  }

  function dealNewGame(silent) {
    gameId += 1;
    // Fresh deal, fresh identity space: suit+rank ids repeat every game, and a
    // leftover element from the last deal would otherwise be mistaken for "the
    // same card, still on screen" by the FLIP diff below.
    cardEls = new Map();
    previouslyVisibleIds = new Set();
    firstRenderOfGame = true;
    previousAiHandCount = 0;
    resolving = false;
    if (!silent) playSound("shuffle");
    deck = buildDeck();
    shuffle(deck);
    trumpCard = deck.pop();
    trumpSuit = trumpCard.suit;
    deck.push(trumpCard); // the trump card ends up at the bottom - drawn last, same as a real deck

    playerHand = [];
    aiHand = [];
    for (let i = 0; i < 6; i++) {
      playerHand.push(deck.shift());
      aiHand.push(deck.shift());
    }
    sortHand(playerHand);

    table = [];
    over = false;
    resultKind = null;
    boutCap = null;

    const lowestTrump = (hand) => {
      const trumps = hand.filter((c) => c.suit === trumpSuit);
      return trumps.length ? trumps.reduce((a, b) => (a.rank < b.rank ? a : b)) : null;
    };
    const playerLow = lowestTrump(playerHand);
    const aiLow = lowestTrump(aiHand);
    if (playerLow && aiLow) attacker = playerLow.rank <= aiLow.rank ? "player" : "ai";
    else if (playerLow) attacker = "player";
    else if (aiLow) attacker = "ai";
    else attacker = Math.random() < 0.5 ? "player" : "ai";
    defender = attacker === "player" ? "ai" : "player";
  }

  function checkGameOver() {
    if (deck.length > 0) return;
    const pEmpty = playerHand.length === 0;
    const aEmpty = aiHand.length === 0;
    if (pEmpty && aEmpty) {
      over = true;
      resultKind = "draw";
    } else if (pEmpty) {
      over = true;
      resultKind = "win";
    } else if (aEmpty) {
      over = true;
      resultKind = "lose";
    }
  }

  function afterBout(kind) {
    // `defender` still names whoever just defended/took THIS bout - the swap
    // below (for "beaten") only happens after this toast is picked, and
    // "taken" never swaps at all. The table clearing looks identical either
    // way on screen, so this is the only signal telling the two apart.
    //
    // Also drives the exit-animation direction in renderAll(): a genuine
    // "beaten" clear discards the cards (nobody keeps them - slide off the
    // board), while "taken" by the AI pulls them into its (anonymous, so
    // untracked) hand - those should animate toward the opponent hand instead.
    // The player's own Take isn't handled here at all: those cards stay
    // tracked (they land in playerHand), so they already get a normal FLIP
    // move to their new hand position, not an exit.
    pendingExitTarget = kind === "taken" && defender === "ai" ? "opponent" : "discard";
    const d = boardEl.dataset;
    showActionToast(
      kind === "taken"
        ? defender === "player"
          ? d.toastYouTake
          : d.toastOpponentTakes
        : defender === "player"
          ? d.toastYouBeat
          : d.toastOpponentBeat
    );
    if (kind === "beaten") {
      // Hold the beaten cards on the table for a beat so both players can
      // see what was thrown/beaten before they're actually discarded -
      // the delay only gates the clear/swap below, not rendering, so the
      // table and toast stay exactly as they are for the full 4s.
      resolving = true;
      updateStatusAndButtons();
      const id = gameId;
      setTimeout(() => {
        if (id !== gameId) return;
        resolving = false;
        table = [];
        const newAttacker = defender;
        const newDefender = attacker;
        attacker = newAttacker;
        defender = newDefender;
        drawUpTo6(attacker);
        drawUpTo6(defender);
        boutCap = null;
        checkGameOver();
        nextAction();
      }, 4000);
      return;
    }
    // "taken": the table's cards were already merged into the taker's hand
    // by the caller. Only the attacker draws back up - the taker already
    // has plenty, and keeps attacking next bout.
    drawUpTo6(attacker);
    boutCap = null;
    checkGameOver();
    nextAction();
  }

  // --- AI --------------------------------------------------------------------

  function byLowestNonTrump(cards) {
    return cards.slice().sort((a, b) => {
      const at = a.suit === trumpSuit ? 1 : 0;
      const bt = b.suit === trumpSuit ? 1 : 0;
      if (at !== bt) return at - bt;
      return a.rank - b.rank;
    });
  }

  function aiChooseAttack(hand) {
    return byLowestNonTrump(hand)[0];
  }

  function aiChooseDefend(hand, atk) {
    const options = hand.filter((c) => beats(c, atk));
    if (!options.length) return null;
    const sameSuit = options.filter((c) => c.suit === atk.suit);
    const pool = (sameSuit.length ? sameSuit : options).slice().sort((a, b) => a.rank - b.rank);
    return pool[0];
  }

  function aiChooseThrowIn(hand) {
    const options = legalThrowIns(hand);
    if (!options.length) return null;
    // Doesn't always press its advantage, so a determined human opponent can win.
    if (Math.random() >= 0.6) return null;
    return byLowestNonTrump(options)[0];
  }

  function aiAct() {
    if (over) return;
    const isDefending = table.length && table[table.length - 1].defense === null;
    if (isDefending) {
      const atk = table[table.length - 1].attack;
      const def = aiChooseDefend(aiHand, atk);
      if (def) {
        playSound("slide");
        table[table.length - 1].defense = def;
        removeCard(aiHand, def);
      } else {
        playSound("slide");
        for (const pair of table) {
          aiHand.push(pair.attack);
          if (pair.defense) aiHand.push(pair.defense);
        }
        table = [];
        afterBout("taken");
        return;
      }
    } else if (table.length === 0) {
      pushAttackCard(aiChooseAttack(aiHand), aiHand);
    } else {
      const card = aiChooseThrowIn(aiHand);
      if (card) {
        pushAttackCard(card, aiHand);
      } else {
        afterBout("beaten");
        return;
      }
    }
    nextAction();
  }

  // --- Player actions ----------------------------------------------------------

  function onPlayerCardClick(card) {
    if (currentActor() !== "player" || over) return;
    const isDefending = table.length && table[table.length - 1].defense === null;
    if (isDefending) {
      const atk = table[table.length - 1].attack;
      if (!beats(card, atk)) return;
      playSound("slide");
      table[table.length - 1].defense = card;
      removeCard(playerHand, card);
    } else {
      if (table.length > 0 && !legalThrowIns(playerHand).includes(card)) return;
      pushAttackCard(card, playerHand);
    }
    nextAction();
  }

  function onTakeClick() {
    if (currentActor() !== "player" || over) return;
    if (!(table.length && table[table.length - 1].defense === null)) return;
    playSound("slide");
    for (const pair of table) {
      playerHand.push(pair.attack);
      if (pair.defense) playerHand.push(pair.defense);
    }
    table = [];
    sortHand(playerHand);
    afterBout("taken");
  }

  function onBitoClick() {
    if (currentActor() !== "player" || over) return;
    if (table.length === 0 || table[table.length - 1].defense === null) return;
    afterBout("beaten");
  }

  // --- Rendering -----------------------------------------------------------
  // Two of the four zones below (opponent hand, deck) are anonymous - every
  // back looks the same, so there's nothing to individually track and they're
  // rebuilt from scratch every render, same as before. The other two (player
  // hand, table) hold cards the player can see and re-see across many renders,
  // so they go through getTrackedFaceEl()'s persistent-node pool instead,
  // which is what lets renderAll() below FLIP-animate them moving between
  // (and within) the two.

  function renderOpponentHand() {
    opponentHandEl.innerHTML = "";
    opponentHandEl.title = boardEl.dataset.opponentTooltip + " " + aiHand.length;
    for (let i = 0; i < aiHand.length; i++) {
      opponentHandEl.appendChild(buildCardBackEl("w-10 h-14", i > 0 ? "-ml-4" : ""));
    }
  }

  function renderDeck() {
    deckEl.innerHTML = "";
    deckEl.title = boardEl.dataset.deckTooltip + " " + deck.length;
    deckCountEl.textContent = String(deck.length);
    if (deck.length > 0) {
      // buildCardEl()'s base class hardcodes w-14 h-20 - the trailing "!"
      // important-modifier is what actually shrinks this, same reasoning as
      // durak-multiplayer.js's own copy of this call.
      deckEl.appendChild(buildCardEl(trumpCard, "w-10! h-14! rotate-90"));
      deckEl.appendChild(buildCardBackEl("w-14 h-20"));
    }
    // Unlike the rotated trump card above (a real deck has nothing left to
    // show once it's empty), this label stays up for the rest of the game -
    // the endgame, once the deck is gone, is exactly when it's easiest to
    // forget which suit is trump.
    trumpLabelEl.textContent = boardEl.dataset.trumpLabel + ": " + SUIT_SYMBOL[trumpSuit];
    trumpLabelEl.className = "text-xs font-medium " + (isRed(trumpSuit) ? "text-red-500" : "text-neutral-300");
  }

  // beforeRects: id -> rect captured at the top of renderAll(), before any DOM
  // mutation this frame. syntheticFlips: moves with no "before" node of their
  // own to measure (a card revealed for the first time, having spent its
  // whole life so far as an anonymous back in the AI's hand) - those animate
  // in from a stand-in origin (the opponent-hand box) instead.
  function renderTable(beforeRects, opponentRect, syntheticFlips) {
    tableEl.innerHTML = "";
    table.forEach((pair) => {
      const wrap = document.createElement("div");
      wrap.className = "relative w-16 h-[5.5rem]";

      const atkId = cardId(pair.attack);
      const atkEl = getTrackedFaceEl(pair.attack);
      wrap.appendChild(positionAbsolute(atkEl, "top-0 left-0"));
      if (!firstRenderOfGame && !beforeRects.has(atkId)) {
        syntheticFlips.push({ el: atkEl, fromRect: opponentRect });
      }

      if (pair.defense) {
        const defId = cardId(pair.defense);
        const defEl = getTrackedFaceEl(pair.defense);
        wrap.appendChild(positionAbsolute(defEl, "top-2 left-2"));
        if (!firstRenderOfGame && !beforeRects.has(defId)) {
          syntheticFlips.push({ el: defEl, fromRect: opponentRect });
        }
      }

      tableEl.appendChild(wrap);
    });
  }

  function computeLegalPlayerCards() {
    if (over || currentActor() !== "player") return new Set();
    if (table.length && table[table.length - 1].defense === null) {
      const atk = table[table.length - 1].attack;
      return new Set(playerHand.filter((c) => beats(c, atk)));
    }
    if (table.length === 0) return new Set(playerHand);
    return new Set(legalThrowIns(playerHand));
  }

  // Click handling is delegated once to playerHandEl (see the listener setup
  // near takeBtn/bitoBtn below) rather than bound per card here - binding here
  // would stack a fresh listener onto the SAME node every render now that
  // cards are reused instead of rebuilt, firing the handler once per render
  // it had lived through.
  function renderPlayerHand(beforeRects, deckRect, syntheticFlips) {
    playerHandEl.innerHTML = "";
    const legal = computeLegalPlayerCards();
    let enteringIndex = 0;
    playerHand.forEach((card) => {
      const id = cardId(card);
      const isLegal = legal.has(card);
      // The extra before:* classes enlarge the clickable area beyond the
      // painted 56x80 card (biased upward, where a hand full of cards packed
      // close together made the top edge the easiest to miss) without
      // changing how big the card actually looks - a plain invisible
      // ::before sized via inset, same "expand touch target" trick as any
      // small tap target. gap-2 on #durak-player-hand (see gameDurak.ejs)
      // keeps two neighboring cards' expanded areas from overlapping.
      const el = getTrackedFaceEl(
        card,
        isLegal
          ? "cursor-pointer hover:-translate-y-2 transition-transform before:content-[''] before:absolute before:-top-2 before:-left-1 before:-right-1 before:-bottom-1"
          : "opacity-40 pointer-events-none"
      );
      el.dataset.cardId = id;
      playerHandEl.appendChild(el);
      if (!beforeRects.has(id)) {
        syntheticFlips.push({ el, fromRect: deckRect, delay: enteringIndex * DEAL_STAGGER_MS });
        enteringIndex++;
      }
    });
  }

  function updateStatusAndButtons() {
    takeBtn.hidden = true;
    bitoBtn.hidden = true;
    if (over) {
      statusEl.textContent = "";
      return;
    }
    if (resolving) {
      statusEl.textContent = "";
      return;
    }
    const d = boardEl.dataset;
    const actor = currentActor();
    if (actor === "ai") {
      statusEl.textContent = d.statusOpponent;
    } else if (table.length && table[table.length - 1].defense === null) {
      statusEl.textContent = d.statusDefend;
      takeBtn.hidden = false;
    } else if (table.length === 0) {
      statusEl.textContent = d.statusAttack;
    } else {
      statusEl.textContent = d.statusThrowin;
      bitoBtn.hidden = false;
    }
  }

  function trackedVisibleIds() {
    const ids = new Set();
    playerHand.forEach((c) => ids.add(cardId(c)));
    table.forEach((pair) => {
      ids.add(cardId(pair.attack));
      if (pair.defense) ids.add(cardId(pair.defense));
    });
    return ids;
  }

  function renderAll() {
    // Measure everything BEFORE touching the DOM this frame: a tracked card's
    // rect only means "where it used to be" if it's captured now, ahead of
    // renderTable()/renderPlayerHand() moving it.
    const deckRect = deckEl.getBoundingClientRect();
    const opponentRect = opponentHandEl.getBoundingClientRect();
    const beforeRects = new Map();
    if (!firstRenderOfGame) {
      for (const id of previouslyVisibleIds) {
        const el = cardEls.get(id);
        if (el && el.isConnected) beforeRects.set(id, el.getBoundingClientRect());
      }
    }
    const aiHandGrew = aiHand.length - previousAiHandCount;

    renderOpponentHand();
    renderDeck();
    const syntheticFlips = [];
    renderTable(beforeRects, opponentRect, syntheticFlips);
    renderPlayerHand(beforeRects, deckRect, syntheticFlips);
    updateStatusAndButtons();
    winsEl.textContent = String(wins);

    // Newly-drawn opponent backs are always appended at the end of aiHand (see
    // drawUpTo6), so the last aiHandGrew children of opponentHandEl are them -
    // give those a deck-origin entrance too, even though (unlike the player's
    // own hand) there's no real per-card identity behind an opponent's back to
    // track across renders.
    if (aiHandGrew > 0) {
      const kids = opponentHandEl.children;
      const start = kids.length - aiHandGrew;
      for (let i = start; i < kids.length; i++) {
        if (kids[i]) syntheticFlips.push({ el: kids[i], fromRect: deckRect, delay: (i - start) * DEAL_STAGGER_MS });
      }
    }
    previousAiHandCount = aiHand.length;

    const nowVisible = trackedVisibleIds();

    // Cards that left the tracked pool without landing back in playerHand/
    // table - beaten (discarded) or taken into the AI's hand (goes anonymous
    // again) - animate toward wherever they actually went instead of just
    // vanishing (see pendingExitTarget, set by afterBout()).
    const exitTowardRect = pendingExitTarget === "opponent" ? opponentRect : null;
    for (const id of previouslyVisibleIds) {
      if (nowVisible.has(id)) continue;
      const el = cardEls.get(id);
      cardEls.delete(id);
      if (el) animateCardExit(el, beforeRects.get(id), exitTowardRect);
    }

    const moves = syntheticFlips;
    for (const [id, rect] of beforeRects) {
      if (!nowVisible.has(id)) continue;
      const el = cardEls.get(id);
      if (el) moves.push({ el, fromRect: rect });
    }
    runFlips(moves);

    previouslyVisibleIds = nowVisible;
    firstRenderOfGame = false;
  }

  // --- Overlay / turn loop ---------------------------------------------------

  function hideOverlay() {
    overlayEl.style.display = "none";
  }

  function showStartOverlay() {
    const d = overlayEl.dataset;
    overlayTitleEl.textContent = d.titleStart;
    overlayWinsEl.hidden = true;
    overlayButtonEl.textContent = d.buttonStart;
    overlayEl.style.display = "";
  }

  function showResultOverlay() {
    const d = overlayEl.dataset;
    if (resultKind === "win") {
      wins += 1;
      writeWins(wins);
      winsEl.textContent = String(wins);
      overlayTitleEl.textContent = d.titleWin;
      overlayWinsEl.hidden = false;
      overlayWinsEl.textContent = d.finalWinsLabel + ": " + wins;
    } else if (resultKind === "lose") {
      overlayTitleEl.textContent = d.titleLose;
      overlayWinsEl.hidden = true;
    } else {
      overlayTitleEl.textContent = d.titleDraw;
      overlayWinsEl.hidden = true;
    }
    overlayButtonEl.textContent = d.buttonAgain;
    overlayEl.style.display = "";
  }

  // Dispatches whoever's turn it is next; renders every state change and, if
  // it's the AI's turn, schedules its move after a short "thinking" delay. The
  // id capture guards against a stray timer from an abandoned game acting on
  // the freshly dealt one if "New Game" is clicked mid-thought.
  function nextAction() {
    renderAll();
    if (over) {
      showResultOverlay();
      return;
    }
    if (currentActor() === "ai") {
      const id = gameId;
      setTimeout(() => {
        if (id === gameId) aiAct();
      }, 500 + Math.random() * 400);
    }
  }

  function startNewGame() {
    dealNewGame();
    hideOverlay();
    nextAction();
  }

  overlayButtonEl.addEventListener("click", () => {
    startNewGame();
    overlayButtonEl.blur();
  });
  newGameBtn?.addEventListener("click", () => {
    startNewGame();
    newGameBtn.blur();
  });
  takeBtn.addEventListener("click", onTakeClick);
  bitoBtn.addEventListener("click", onBitoClick);

  // Delegated: cards are persistent nodes now (reused across renders for the
  // FLIP animation), so a listener bound directly to a card would stack a
  // duplicate onto the same node every render. An illegal card never reaches
  // this handler in the first place - it's styled pointer-events-none, which
  // stops the click from targeting it at all.
  playerHandEl.addEventListener("click", (e) => {
    const cardEl = e.target.closest(".durak-card");
    if (!cardEl || !cardEl.dataset.cardId) return;
    const card = playerHand.find((c) => cardId(c) === cardEl.dataset.cardId);
    if (card) onPlayerCardClick(card);
  });

  // --- Boot --------------------------------------------------------------------

  gameId = 0;
  wins = readWins();
  winsEl.textContent = String(wins);
  dealNewGame(true);
  renderAll();
  showStartOverlay();
})();
