// /games/durak's "play with people" section - the real-time client. Unlike
// public/js/games/durak.js (single-player, fully client-authoritative), this client renders
// whatever realtime/durakRoomManager.js pushes over the WebSocket and never
// computes game rules itself - every action it sends is just a request the
// server may reject (an "error" message comes back, rendered as a toast).
// Card-rendering helpers are a deliberate near-duplicate of durak.js's
// (extended to ranks 2-14 for 6-player rooms) rather than a shared module -
// same "each on-site game owns its own independent client script" convention
// the other three games already follow.
(function () {
  "use strict";

  const root = document.getElementById("dmp-root");
  if (!root) return;

  const d = root.dataset;
  const myUserId = d.myUserId;

  const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };

  function rankLabel(rank) {
    return RANK_LABEL[rank] || String(rank);
  }
  function isRed(suit) {
    return suit === "H" || suit === "D";
  }

  function buildCardEl(card, extraClass) {
    const el = document.createElement("div");
    el.className =
      "durak-card relative w-14 h-20 rounded-md bg-neutral-100 border border-neutral-300 shadow-sm shrink-0" +
      (extraClass ? " " + extraClass : "");
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
    return el;
  }

  // p.avatarUrl/p.color/p.rating come from durakRoomManager.js's serializeRoomMeta
  // (fetched once per join via loadPlayerProfile() - see that comment) - all
  // three can be null (lookup still in flight, or - for rating - the player
  // simply hasn't finished a rated multiplayer game yet), so every caller here
  // has to tolerate that instead of assuming they're always present. Same
  // fallback-initial-circle pattern as views/partials/nav.ejs's own avatar.
  function buildAvatarEl(p) {
    if (p.avatarUrl) {
      const img = document.createElement("img");
      img.src = p.avatarUrl;
      img.alt = "";
      img.width = 24;
      img.height = 24;
      img.className = "w-6 h-6 rounded-full shrink-0 object-cover";
      return img;
    }
    const fallback = document.createElement("span");
    fallback.className =
      "w-6 h-6 rounded-full shrink-0 grid place-items-center bg-neutral-800 text-neutral-300 text-[10px] font-semibold";
    fallback.textContent = (p.displayName || "?").charAt(0).toUpperCase();
    return fallback;
  }

  // sizeClass is required, not optional - Tailwind's compiled stylesheet
  // order decides which width/height utility wins on one element, not the
  // order classes appear in this string (same gotcha positionAbsolute()
  // below documents for "relative"/"absolute"), so a hardcoded default size
  // here would silently outrank whatever size a caller tried to override it
  // with instead of composing with it.
  function buildCardBackEl(sizeClass, extraClass) {
    const el = document.createElement("div");
    el.className =
      sizeClass + " rounded-md border-2 border-purple-950 shrink-0 bg-purple-800 ring-1 ring-inset ring-purple-500/40" +
      (extraClass ? " " + extraClass : "");
    return el;
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

  // A table pair (attack + optional defense, still wrapped together) that just
  // got swept off the table - beaten or taken - reparented onto the board at
  // its last known screen position and animated out instead of just vanishing
  // when tableCardsEl gets wiped. Same technique as durak.js's
  // animateCardExit, adapted to this file's "whole pair, not per-card identity"
  // rendering (see the file banner - no persistent per-card DOM nodes here).
  //
  // towardRect, if given, is the rect to shrink toward (whoever just took the
  // table - see pendingTakeSeat) instead of sliding off to the right (a
  // genuine "beaten" discard - nobody keeps those cards).
  function animateTableExit(el, fromRect, towardRect) {
    if (!fromRect) {
      el.remove();
      return;
    }
    const boardRect = dmpBoardEl.getBoundingClientRect();
    el.style.transition = "none";
    el.style.position = "absolute";
    el.style.margin = "0";
    el.style.left = fromRect.left - boardRect.left + "px";
    el.style.top = fromRect.top - boardRect.top + "px";
    el.style.zIndex = "5";
    el.style.opacity = "1";
    dmpBoardEl.appendChild(el);
    void el.offsetHeight; // force layout before animating
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

  function cardsEqual(a, b) {
    return a.suit === b.suit && a.rank === b.rank;
  }

  // --- Sticker reactions -----------------------------------------------------
  // A fixed set of 7TV-sourced images (durakRoomManager.js server-validates
  // stickerId against the same three ids) any seated player can fire off
  // mid-game as a lightweight reaction - it never touches game state, so it's
  // routed entirely outside the roomState/action message flow (see the
  // "sticker" branch in handleMessage()).
  const STICKER_BASE = "/images/games/durak/stickers/";
  const STICKER_FILES = { subprise: "subprise.png", bloodtrail: "bloodtrail.png", jokerge: "jokerge.png" };

  // How long a popped sticker stays in the DOM - must be >= the
  // durak-sticker-pop CSS animation's own duration (public/css/input.css) so
  // reduced-motion visitors (animation skipped, element left at opacity: 1)
  // still get it cleaned up on the same schedule as everyone else.
  const STICKER_POP_MS = 1400;

  // Anchors the popped sticker over whoever sent it: the sender's own hand
  // panel if it was me (my own seat has no block in #dmp-opponents - see
  // renderTable()'s seatOrder, which always excludes mySeat), otherwise that
  // seat's opponent block, which every viewer (seated or spectating) has one
  // of. Silently no-ops if neither exists yet (a stale/racing message against
  // a room the client has already left).
  function showSticker(seat, stickerId) {
    const file = STICKER_FILES[stickerId];
    if (!file) return;
    const anchor = seat === mySeat ? handPanelEl : opponentsEl.querySelector('[data-seat="' + seat + '"]');
    if (!anchor || !dmpBoardEl) return;
    const anchorRect = anchor.getBoundingClientRect();
    const boardRect = dmpBoardEl.getBoundingClientRect();
    const img = document.createElement("img");
    img.src = STICKER_BASE + file;
    img.alt = "";
    img.className = "durak-sticker-pop absolute w-14 h-14 pointer-events-none drop-shadow-lg";
    img.style.left = anchorRect.left - boardRect.left + anchorRect.width / 2 - 28 + "px";
    img.style.top = anchorRect.top - boardRect.top - 56 + "px";
    img.style.zIndex = "30";
    dmpBoardEl.appendChild(img);
    setTimeout(() => img.remove(), STICKER_POP_MS);
  }

  // --- Sound ---------------------------------------------------------------
  // Same cloneNode()-per-play pattern as durak.js (bot mode) and the other
  // on-site games - lets overlapping plays (several opponents acting in quick
  // succession) layer instead of cutting each other off. This client has no
  // persistent per-card DOM identity (see the file banner above - every
  // roomState fully rebuilds the table/hand), so unlike durak.js this can't
  // hook individual card moves directly; playSound("slide") is instead driven
  // off a before/after diff of how many table slots are filled (see
  // renderTable() below), and fires for anyone's move, not just the local
  // player's.

  const SOUND_BASE = "/sounds/games/durak/";
  const SOUNDS = {
    slide: new Audio(SOUND_BASE + "card_slide.wav"),
    shuffle: new Audio(SOUND_BASE + "shuffle.wav"),
    notification: new Audio(SOUND_BASE + "message-notification.wav"),
  };
  for (const audio of Object.values(SOUNDS)) audio.volume = 0.5;

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

  // Tracks how many table slots (attack + filled defense) were occupied as of
  // the last renderTable() call, so the next call can tell whether a card was
  // just added (attack/defend/throw-in) or the table was just cleared
  // (beaten/taken) - either way, something visibly moved, so play "slide".
  // Reset to 0 whenever a fresh deal starts (see justDealt in renderRoom()).
  let previousTableFilled = 0;

  // Stagger between each card's deal-in animation start, in ms - mirrors
  // durak.js's DEAL_STAGGER_MS (see its comment: tuned so the full deal
  // roughly covers shuffle.wav's ~0.98s runtime instead of finishing while
  // the sound is still playing).
  const DEAL_STAGGER_MS = 130;

  function dealInAnimate(el, index) {
    if (!el.animate) return;
    el.animate(
      [
        { transform: "translateY(-10px) scale(0.85)", opacity: 0 },
        { transform: "translateY(0) scale(1)", opacity: 1 },
      ],
      { duration: 240, delay: index * DEAL_STAGGER_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }
    );
  }

  // --- DOM refs ----------------------------------------------------------------

  const connStatusEl = document.getElementById("dmp-connstatus");
  const boardToastEl = document.getElementById("dmp-board-toast");
  const lobbyViewEl = document.getElementById("dmp-lobby-view");
  const roomViewEl = document.getElementById("dmp-room-view");
  const roomListEl = document.getElementById("dmp-room-list");
  const roomListEmptyEl = document.getElementById("dmp-room-list-empty");
  const createRoomBtn = document.getElementById("dmp-create-room-btn");
  const playingListEl = document.getElementById("dmp-playing-list");
  const playingListEmptyEl = document.getElementById("dmp-playing-list-empty");

  const roomCodeEl = document.getElementById("dmp-room-code");
  const copyLinkBtn = document.getElementById("dmp-copy-link-btn");
  const spectatorCountEl = document.getElementById("dmp-spectator-count");
  const avgRatingEl = document.getElementById("dmp-avg-rating");
  const earlyFinishBannerEl = document.getElementById("dmp-early-finish-banner");
  const spectatingBadgeEl = document.getElementById("dmp-spectating-badge");
  const startBtn = document.getElementById("dmp-start-btn");
  const leaveBtn = document.getElementById("dmp-leave-btn");
  const stopWatchingBtn = document.getElementById("dmp-stop-watching-btn");
  const playerListEl = document.getElementById("dmp-player-list");
  const waitingHintEl = document.getElementById("dmp-waiting-hint");

  const rulesPanelEl = document.getElementById("dmp-rules-panel");
  const ruleThrowInsEl = document.getElementById("dmp-rule-throwins");
  const ruleTransfersEl = document.getElementById("dmp-rule-transfers");
  const rulesHostHintEl = document.getElementById("dmp-rules-host-hint");

  const readyCheckEl = document.getElementById("dmp-ready-check");
  const readyCountdownEl = document.getElementById("dmp-ready-countdown");
  const readyCountEl = document.getElementById("dmp-ready-count");
  const readyAcceptBtn = document.getElementById("dmp-ready-accept-btn");
  const readyWaitingEl = document.getElementById("dmp-ready-waiting");

  const actionChoiceEl = document.getElementById("dmp-action-choice");
  const actionChoicePromptEl = document.getElementById("dmp-action-choice-prompt");
  const choiceBeatBtn = document.getElementById("dmp-choice-beat-btn");
  const choiceTransferBtn = document.getElementById("dmp-choice-transfer-btn");

  const tableWrapEl = document.getElementById("dmp-table-wrap");
  const dmpBoardEl = document.getElementById("dmp-board");
  const opponentsEl = document.getElementById("dmp-opponents");
  const deckEl = document.getElementById("dmp-deck");
  const deckCountEl = document.getElementById("dmp-deck-count");
  const trumpLabelEl = document.getElementById("dmp-trump-label");
  const tableCardsEl = document.getElementById("dmp-table-cards");
  const statusEl = document.getElementById("dmp-status");
  const takeBtn = document.getElementById("dmp-take-btn");
  const passBtn = document.getElementById("dmp-pass-btn");
  const handPanelEl = document.getElementById("dmp-hand-panel");
  const handEl = document.getElementById("dmp-hand");
  const myClockEl = document.getElementById("dmp-my-clock");
  const stickersEl = document.getElementById("dmp-stickers");
  const stickerBtns = stickersEl ? Array.from(stickersEl.querySelectorAll("[data-sticker-id]")) : [];
  for (const btn of stickerBtns) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.stickerId;
      if (STICKER_FILES[id]) send({ type: "sticker", stickerId: id });
    });
  }

  const resultOverlayEl = document.getElementById("dmp-result-overlay");
  const resultTitleEl = document.getElementById("dmp-result-title");
  const resultDetailEl = document.getElementById("dmp-result-detail");
  const resultStandingsEl = document.getElementById("dmp-result-standings");
  const resultBackBtn = document.getElementById("dmp-result-back-btn");

  // --- Connection --------------------------------------------------------------

  let ws = null;
  let reconnectAttempt = 0;
  let deliberateClose = false;
  let currentRoomId = null;
  let lastRoom = null; // set by renderRoom() - lets a later "action" message resolve seat -> player
  let mySeat = null; // set from game.you.seat once seated - lets narrateAction() say "You" for my own moves; stays null while spectating (see isSpectating)
  let isSpectating = false; // set from roomState's "spectating" flag (durakRoomManager.js's watchRoom path) - read-only view, no game.you/game.legal to draw from
  // Elo deltas for the just-finished game arrive as their own "ratingChanges"
  // message, separately and slightly after the roomState that first shows the
  // result overlay (realtime/durakRoomManager.js computes/persists them via a
  // DB round-trip it doesn't block the result broadcast on) - stashed here so
  // renderStandings() can render with or without them, and re-render in place
  // once they land.
  let lastGame = null; // set by renderTable() whenever game.result is present
  let lastRatingChanges = null;
  // My own Elo delta for the seat I've already finished in, while the rest of
  // the table is still playing - a separate stash from lastRatingChanges
  // (which resets on every non-result roomState, see renderTable()) since
  // this one needs to survive every subsequent roomState broadcast for the
  // REST of this same match, right up until game.result finally lands.
  // updateEarlyFinishBanner() clears it back to null the moment my own
  // finishRank is null again - i.e. a genuinely new game, not just someone
  // else's move in this one.
  let myEarlyRatingChange = null;
  let pendingTakeSeat = null; // set by handleMessage()'s "action" branch, consumed by renderTable()

  // --- Lobby join notification ---------------------------------------------
  // Tracks which userIds were already in the lobby's player list as of the
  // last render, so a genuinely new arrival (an id not seen before) plays a
  // sound while a reconnect (durakRoomManager.js keeps a disconnected lobby
  // player's entry - and userId - around for a 60s grace period, just
  // flipping connected false->true) stays silent. Keyed to the room id so a
  // fresh lobby (created/joined after leaving a previous one) doesn't compare
  // against a stale roster; null on the very first render of a lobby so
  // seeing your own already-present self for the first time never fires it.
  let previousLobbyPlayerIds = null;
  let previousLobbyPlayerRoomId = null;

  // --- Per-player time budget (chess-clock style) -------------------------
  // The server only sends a fresh {remainingMs, runningSeats, serverNow}
  // snapshot when something actually happens (an action, a leave, or its own
  // expiry timer firing) - not continuously. Between snapshots this client
  // interpolates locally so the displayed numbers still count down smoothly.
  let clocksSnapshot = null;
  let clockTickHandle = null;

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function displayedRemainingMs(seat) {
    if (!clocksSnapshot || clocksSnapshot.remainingMs[seat] == null) return null;
    const base = clocksSnapshot.remainingMs[seat];
    const running = clocksSnapshot.runningSeats.includes(seat);
    const elapsed = running ? Date.now() - clocksSnapshot.serverNow : 0;
    return Math.max(0, base - elapsed);
  }

  const LOW_TIME_MS = 30 * 1000;

  function renderClockDisplays() {
    if (!clocksSnapshot) return;
    if (mySeat != null) {
      const mine = displayedRemainingMs(mySeat);
      if (mine != null) {
        myClockEl.textContent = formatClock(mine);
        myClockEl.classList.toggle("text-rose-500", mine < LOW_TIME_MS);
        myClockEl.classList.toggle("text-neutral-400", mine >= LOW_TIME_MS);
      }
    }
    opponentsEl.querySelectorAll("[data-clock-seat]").forEach((el) => {
      const seat = Number(el.dataset.clockSeat);
      const rem = displayedRemainingMs(seat);
      if (rem == null) return;
      el.textContent = formatClock(rem);
      el.classList.toggle("text-rose-500", rem < LOW_TIME_MS);
    });
  }

  function stopClockTicking() {
    if (clockTickHandle) {
      clearInterval(clockTickHandle);
      clockTickHandle = null;
    }
  }

  function ensureClockTicking() {
    if (clockTickHandle) return;
    clockTickHandle = setInterval(renderClockDisplays, 250);
  }

  // --- Ready check ---------------------------------------------------------
  // deadline is an absolute server timestamp (unlike the per-player clock
  // above, this timer never pauses/resumes, so there's no need for the
  // running-seats interpolation dance - Date.now() - deadline is enough).
  let readyCheckDeadline = null;
  let readyCheckTickHandle = null;
  // Dedupes the notification sound against the deadline value itself, since a
  // new ready check (a new Start click after a previous one lapsed/cancelled)
  // gets a fresh deadline - re-renders of the SAME check (accept counts
  // ticking up) must not replay the sound.
  let readyCheckSoundPlayedFor = null;

  function renderReadyCountdown() {
    if (readyCheckDeadline == null) return;
    const remainingSeconds = Math.max(0, Math.ceil((readyCheckDeadline - Date.now()) / 1000));
    readyCountdownEl.textContent = fillTemplate(d.readyCountdownTpl, { SECONDS: remainingSeconds });
  }

  function stopReadyCheckTicking() {
    if (readyCheckTickHandle) {
      clearInterval(readyCheckTickHandle);
      readyCheckTickHandle = null;
    }
    readyCheckDeadline = null;
  }

  function ensureReadyCheckTicking() {
    if (readyCheckTickHandle) return;
    readyCheckTickHandle = setInterval(renderReadyCountdown, 250);
  }

  function renderReadyCheck(rc) {
    if (!rc) return;
    readyCheckEl.hidden = false;
    readyCheckDeadline = rc.deadline;
    readyCountEl.textContent = fillTemplate(d.readyAcceptedTpl, { ACCEPTED: rc.acceptedCount, TOTAL: rc.totalCount });
    readyAcceptBtn.hidden = rc.youAccepted;
    readyWaitingEl.hidden = !rc.youAccepted;
    if (readyCheckSoundPlayedFor !== rc.deadline) {
      readyCheckSoundPlayedFor = rc.deadline;
      playSound("notification");
    }
    ensureReadyCheckTicking();
    renderReadyCountdown(); // paint immediately - the 250ms interval alone would leave a blank flash
  }

  readyAcceptBtn.addEventListener("click", () => {
    send({ type: "acceptStart" });
    readyAcceptBtn.blur();
  });

  // --- Host-editable game rules --------------------------------------------
  // Only meaningful while the room is still "lobby" (see renderRoom()) -
  // server-enforced too (durakRoomManager.js's handleSetRules rejects
  // non-host senders and any status other than "lobby"), this is just the UI
  // reflecting that same gate so a non-host or a too-late click never looks
  // like it should have worked.

  function renderRulesPanel(rules, amHost, roomStatus) {
    rulesPanelEl.hidden = roomStatus !== "lobby";
    if (!rules) return;
    ruleThrowInsEl.checked = rules.allowThrowIns !== false;
    ruleThrowInsEl.disabled = !amHost;
    ruleTransfersEl.checked = rules.allowTransfers === true;
    ruleTransfersEl.disabled = !amHost;
    rulesHostHintEl.hidden = amHost;
  }

  ruleThrowInsEl.addEventListener("change", () => {
    send({ type: "setRules", rules: { allowThrowIns: ruleThrowInsEl.checked } });
  });
  ruleTransfersEl.addEventListener("change", () => {
    send({ type: "setRules", rules: { allowTransfers: ruleTransfersEl.checked } });
  });

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + d.wsPath;
  }

  function setConnStatus(text) {
    connStatusEl.textContent = text || "";
  }

  function connect() {
    deliberateClose = false;
    ws = new WebSocket(wsUrl());
    setConnStatus(reconnectAttempt > 0 ? d.statusReconnecting : d.statusConnecting);

    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      setConnStatus("");
      const autoJoin = d.autoJoinRoomId;
      if (autoJoin) send({ type: "joinRoom", roomId: autoJoin });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      handleMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (deliberateClose) return;
      setConnStatus(d.statusReconnecting);
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 15000);
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  // --- Message handling --------------------------------------------------------

  function handleMessage(msg) {
    if (msg.type === "lobbyState") {
      renderLobbyList(msg.rooms);
      renderPlayingList(msg.playingRooms || []);
    } else if (msg.type === "roomState") {
      currentRoomId = msg.room.id;
      isSpectating = !!msg.spectating;
      renderRoom(msg);
    } else if (msg.type === "action") {
      narrateAction(msg.seat, msg.action);
      // Stashed for renderTable()'s exit animation: a "take" clear should
      // animate the table's cards toward whoever just took them rather than
      // off the board (only "beaten" is a genuine discard). Arrives ahead of
      // the roomState that actually clears the table (see the comment below),
      // and renderTable() consumes+resets it the moment it's read.
      pendingTakeSeat = msg.action === "take" ? msg.seat : null;
    } else if (msg.type === "sticker") {
      showSticker(msg.seat, msg.stickerId);
    } else if (msg.type === "kicked") {
      // The host kicked me from a room I'm still looking at (durakRoomManager.js's
      // handleKickPlayer) - the "lobbyState" that immediately follows this message
      // won't render otherwise, since renderLobbyList()/renderPlayingList() both
      // bail out early while currentRoomId is still set to the room I just lost my seat in.
      resetRoomUiState();
      showToast(d.kickedToast);
    } else if (msg.type === "ratingChanges") {
      if (msg.early) {
        const mine = msg.changes.find((c) => c.seat === mySeat);
        if (mine) {
          // roomId matching my current room means I'm still sitting there
          // watching the rest of the match play out (a normal early
          // finisher) - update the in-context banner. Anything else - most
          // commonly a player who just LEFT (realtime/durakRoomManager.js
          // pays a leaver out the same way, but leaving is what triggers the
          // payout, so by the time its DB round-trip resolves I'm already
          // back in the lobby with no game on screen to show a banner on;
          // could also just be the stray old-room race this used to be the
          // sole guard against) - surface it as a toast instead so it isn't
          // silently lost.
          if (msg.roomId === currentRoomId) {
            myEarlyRatingChange = mine;
            if (lastRenderedGame) updateEarlyFinishBanner(lastRenderedGame);
          } else {
            const sign = mine.delta > 0 ? "+" : "";
            showToast(fillTemplate(d.toastRatingChangeTpl, { RANK: mine.place, DELTA: sign + mine.delta }));
          }
        }
      } else {
        lastRatingChanges = msg.changes;
        if (lastRoom && lastGame && !resultOverlayEl.hidden) renderStandings(lastRoom, lastGame);
      }
    } else if (msg.type === "error") {
      showToast(errorText(msg.code));
    }
  }

  // realtime/durakRoomManager.js narrates the moves that leave no visible
  // trace of their own: passing (nothing changes on screen at all), the
  // table clearing (identical whether it was cleanly beaten off or the
  // defender gave up and took everything), and a clock timeout (the seat just
  // silently drops out) - see its broadcastAction()/syncClock(). Arrives as
  // its own message ahead of the roomState it triggered, so lastRoom here is
  // still the pre-move player list, which is all this needs (seat -> display
  // name doesn't change mid-hand).
  function narrateAction(seat, action) {
    const player = lastRoom && lastRoom.players[seat];
    const name = seat === mySeat ? d.youLabel : player ? player.displayName : "?";
    const tpl = {
      pass: d.actionPassTpl,
      take: d.actionTakeTpl,
      beaten: d.actionBeatenTpl,
      transfer: d.actionTransferTpl,
      timeout: d.actionTimeoutTpl,
    }[action];
    if (tpl) showToast(fillTemplate(tpl, { NAME: name }));
  }

  function errorText(code) {
    const map = {
      "room-not-found": d.errRoomNotFound,
      "room-full": d.errRoomFull,
      "room-not-joinable": d.errRoomNotJoinable,
      "rate-limited": d.errRateLimited,
      "already-in-room": d.errAlreadyInRoom,
      "not-enough-players": d.errNotEnoughPlayers,
      "not-host": d.errNotHost,
      "room-not-watchable": d.errRoomNotWatchable,
      "sticker-rate-limited": d.errStickerRateLimited,
      "not-in-lobby": d.errNotInLobby,
      "player-not-found": d.errPlayerNotFound,
    };
    return map[code] || d.errGeneric;
  }

  let boardToastTimer = null;

  function showToast(text) {
    // While the board is on screen (an active room, any status), narrate
    // right on it - #dmp-connstatus sits far above the lobby/room view and
    // goes unnoticed once a game is underway, since attention is on the
    // board by then. Otherwise (still in the lobby, nothing to show it on)
    // fall back to the original top status line.
    if (!roomViewEl.hidden && !tableWrapEl.hidden) {
      boardToastEl.textContent = text;
      boardToastEl.hidden = false;
      clearTimeout(boardToastTimer);
      boardToastTimer = setTimeout(() => {
        boardToastEl.hidden = true;
      }, 4000);
    } else {
      setConnStatus(text);
      setTimeout(() => setConnStatus(""), 4000);
    }
  }

  // --- Lobby rendering -----------------------------------------------------

  function renderLobbyList(rooms) {
    if (currentRoomId) return; // already in a room, the lobby list isn't shown
    roomListEl.querySelectorAll("[data-room-row]").forEach((el) => el.remove());
    roomListEmptyEl.hidden = rooms.length > 0;
    for (const r of rooms) {
      const li = document.createElement("li");
      li.dataset.roomRow = "1";
      li.className = "flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5";

      const info = document.createElement("div");
      const hostLine = document.createElement("p");
      hostLine.className = "text-sm text-neutral-200";
      hostLine.append(d.hostPrefix + " ");
      const hostNameSpan = document.createElement("span");
      hostNameSpan.textContent = r.hostDisplayName;
      hostNameSpan.title = ratingTooltip(r.hostRating);
      hostLine.appendChild(hostNameSpan);
      const countLine = document.createElement("p");
      countLine.className = "text-xs text-neutral-500";
      countLine.textContent =
        fillTemplate(d.playersCountTpl, { COUNT: r.playerCount, MAX: r.maxPlayers }) +
        (r.avgRating != null ? " · " + fillTemplate(d.avgRatingTpl, { RATING: r.avgRating }) : "");
      info.append(hostLine, countLine);

      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = "px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors shrink-0";
      joinBtn.textContent = d.joinLabel;
      joinBtn.addEventListener("click", () => send({ type: "joinRoom", roomId: r.id }));

      li.append(info, joinBtn);
      roomListEl.appendChild(li);
    }
  }

  // Rooms with a hand already in progress (server-filtered to status
  // "playing" - see durakRoomManager.js's buildLobbySnapshot). A row here
  // sends "watchRoom" instead of "joinRoom" - the visitor becomes a
  // read-only spectator, never a seated player, of that room.
  function renderPlayingList(rooms) {
    if (currentRoomId) return; // already in a room (seated or spectating) - the lobby view isn't shown
    playingListEl.querySelectorAll("[data-playing-row]").forEach((el) => el.remove());
    playingListEmptyEl.hidden = rooms.length > 0;
    for (const r of rooms) {
      const li = document.createElement("li");
      li.dataset.playingRow = "1";
      li.className = "flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5";

      const info = document.createElement("div");
      const namesLine = document.createElement("p");
      namesLine.className = "text-sm text-neutral-200 truncate max-w-xs";
      r.players.forEach((p, i) => {
        if (i > 0) namesLine.append(", ");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = p.displayName + (p.left ? " ✗" : "");
        nameSpan.title = ratingTooltip(p.rating);
        namesLine.appendChild(nameSpan);
      });
      const countLine = document.createElement("p");
      countLine.className = "text-xs text-neutral-500";
      countLine.textContent =
        fillTemplate(d.matchPlayerCountTpl, { COUNT: r.playerCount }) +
        (r.spectatorCount > 0 ? " · " + fillTemplate(d.spectatorCountTpl, { COUNT: r.spectatorCount }) : "") +
        (r.avgRating != null ? " · " + fillTemplate(d.avgRatingTpl, { RATING: r.avgRating }) : "");
      info.append(namesLine, countLine);

      const watchBtn = document.createElement("button");
      watchBtn.type = "button";
      watchBtn.className = "px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm font-medium transition-colors shrink-0";
      watchBtn.textContent = d.watchLabel;
      watchBtn.addEventListener("click", () => send({ type: "watchRoom", roomId: r.id }));

      li.append(info, watchBtn);
      playingListEl.appendChild(li);
    }
  }

  function fillTemplate(tpl, vars) {
    let out = tpl || "";
    for (const key of Object.keys(vars)) out = out.split("__" + key + "__").join(String(vars[key]));
    return out;
  }

  function ratingTooltip(rating) {
    return rating != null ? fillTemplate(d.playerRatingTpl, { RATING: rating }) : d.playerRatingUnknown;
  }

  createRoomBtn.addEventListener("click", () => {
    send({ type: "createRoom" });
    createRoomBtn.blur();
  });

  // --- Room rendering ------------------------------------------------------

  function switchView(inRoom) {
    lobbyViewEl.hidden = inRoom;
    roomViewEl.hidden = !inRoom;
  }

  function renderRoom(msg) {
    switchView(true);
    const room = msg.room;
    lastRoom = room;
    roomCodeEl.textContent = room.id;

    leaveBtn.hidden = isSpectating;
    stopWatchingBtn.hidden = !isSpectating;
    spectatingBadgeEl.hidden = !isSpectating;
    spectatorCountEl.hidden = !room.spectatorCount;
    if (room.spectatorCount) spectatorCountEl.textContent = fillTemplate(d.spectatorCountTpl, { COUNT: room.spectatorCount });
    avgRatingEl.hidden = room.avgRating == null;
    if (room.avgRating != null) avgRatingEl.textContent = fillTemplate(d.avgRatingTpl, { RATING: room.avgRating });

    const amHost = !isSpectating && room.hostUserId === myUserId;

    playerListEl.textContent = "";
    room.players.forEach((p) => {
      const li = document.createElement("li");
      const isMe = p.userId === myUserId;
      const isHost = p.userId === room.hostUserId;
      li.className =
        "flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border " +
        (p.left
          ? "border-neutral-800 text-neutral-600 line-through"
          : p.connected
            ? "border-neutral-700 text-neutral-200"
            : "border-amber-700 text-amber-500") +
        (isMe ? " ring-2 ring-purple-400" : "");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.displayName + (isHost ? " ★" : "");
      li.appendChild(nameSpan);
      // Host-only, lobby-only (durakRoomManager.js's handleKickPlayer enforces
      // the same two gates server-side) - never shown for the host's own row.
      if (amHost && room.status === "lobby" && !isMe) {
        const kickBtn = document.createElement("button");
        kickBtn.type = "button";
        kickBtn.className = "text-neutral-500 hover:text-rose-400 leading-none px-0.5";
        kickBtn.textContent = "✕";
        kickBtn.title = d.kickButtonTitle;
        kickBtn.addEventListener("click", () => send({ type: "kickPlayer", userId: p.userId }));
        li.appendChild(kickBtn);
      }
      playerListEl.appendChild(li);
    });

    renderRulesPanel(room.rules, amHost, room.status);
    if (room.status === "lobby") {
      startBtn.hidden = !amHost;
      waitingHintEl.hidden = room.players.length >= 2;
      readyCheckEl.hidden = true;
      stopReadyCheckTicking();
      tableWrapEl.hidden = true;
      clocksSnapshot = null;
      stopClockTicking();

      if (previousLobbyPlayerRoomId !== room.id) {
        previousLobbyPlayerIds = null;
        previousLobbyPlayerRoomId = room.id;
      }
      const currentPlayerIds = new Set(room.players.map((p) => p.userId));
      if (previousLobbyPlayerIds) {
        const isNewArrival = [...currentPlayerIds].some((id) => !previousLobbyPlayerIds.has(id));
        if (isNewArrival) playSound("notification");
      }
      previousLobbyPlayerIds = currentPlayerIds;
    } else if (room.status === "starting") {
      // The ready check - see durakRoomManager.js's handleStartGame(). No
      // game/table exists yet, so tableWrapEl stays hidden through this
      // whole phase (that's also what lets the "playing" branch below detect
      // its own justDealt moment correctly).
      startBtn.hidden = true;
      waitingHintEl.hidden = true;
      tableWrapEl.hidden = true;
      clocksSnapshot = null;
      stopClockTicking();
      renderReadyCheck(msg.readyCheck);
    } else {
      readyCheckEl.hidden = true;
      stopReadyCheckTicking();
      // tableWrapEl is only ever hidden while status is "lobby"/"starting" -
      // the moment this branch first runs for a room is the moment it just
      // got dealt (a room plays exactly one game, so this flips
      // true->false exactly once).
      const justDealt = tableWrapEl.hidden;
      startBtn.hidden = true;
      waitingHintEl.hidden = true;
      tableWrapEl.hidden = false;
      // game.you is absent entirely for a spectator's payload (see
      // durakEngine.js's serializeForSpectator) - stays null rather than
      // carrying over a stale seat number from a previous seated session in
      // this same tab (leaveRoom -> watchRoom is one connection, mySeat
      // otherwise wouldn't get reset).
      mySeat = msg.game && msg.game.you ? msg.game.you.seat : null;
      clocksSnapshot = msg.clocks || null;
      // A genuinely new authoritative state supersedes any in-progress
      // multi-target beat pick (hand/table may have changed under it) -
      // unlike renderTable() itself, which is also called for purely local
      // redraws while a pick is still pending and must NOT clear it.
      pendingDefendCard = null;
      pendingDefendIndices = [];
      renderTable(room, msg.game, justDealt);
      if (msg.game && msg.game.result) {
        stopClockTicking(); // game over - the snapshot is now static, no need to keep polling
      } else {
        ensureClockTicking();
      }
    }
  }

  // Shared by every "back to the lobby" path (leave as player, stop watching,
  // back-from-result) - resets every piece of per-room client state so the
  // next roomState (a fresh join or watch) never inherits a stale seat
  // number, clock snapshot, or dedup marker from whatever this tab was doing before.
  function resetRoomUiState() {
    currentRoomId = null;
    isSpectating = false;
    mySeat = null;
    clocksSnapshot = null;
    stopClockTicking();
    stopReadyCheckTicking();
    readyCheckSoundPlayedFor = null;
    previousLobbyPlayerIds = null;
    previousLobbyPlayerRoomId = null;
    switchView(false);
  }

  startBtn.addEventListener("click", () => {
    send({ type: "startGame" });
    startBtn.blur();
  });
  leaveBtn.addEventListener("click", () => {
    // Leaving mid-hand forfeits it outright (durakEngine.js's removePlayer()
    // never redistributes the abandoned hand) - confirm first so a stray
    // click doesn't cost a game that was still winnable. No confirmation
    // needed once the hand's already empty (lobby, or already finished/out) -
    // there's nothing left to lose by leaving.
    const game = lastRenderedGame;
    const stillPlaying = game && !game.result && game.you && game.you.hand.length > 0;
    if (stillPlaying && !window.confirm(d.leaveConfirm)) {
      leaveBtn.blur();
      return;
    }
    send({ type: "leaveRoom" });
    leaveBtn.blur();
    resetRoomUiState();
  });
  stopWatchingBtn.addEventListener("click", () => {
    send({ type: "leaveWatch" });
    stopWatchingBtn.blur();
    resetRoomUiState();
  });
  resultBackBtn.addEventListener("click", () => {
    send({ type: isSpectating ? "leaveWatch" : "leaveRoom" });
    resultBackBtn.blur();
    resetRoomUiState();
  });
  copyLinkBtn.addEventListener("click", () => {
    const url = location.origin + "/games/durak/room/" + roomCodeEl.textContent;
    navigator.clipboard?.writeText(url).then(() => showToast(d.linkCopied)).catch(() => {});
  });

  // --- Table rendering -----------------------------------------------------

  // "Attacking"/"defending"/"passed" text next to a seat's border color - the
  // color alone (purple attacker, rose defender) isn't self-explanatory to
  // everyone, so this spells it out. Empty once a seat is done (out/left) or
  // has nothing to report (e.g. attacker's own opening move is over and play
  // has moved to "defend" - nothing left for them to visibly be doing).
  function seatRoleLabel(game, seat, meta) {
    if (meta.out || meta.left) return "";
    if (game.phase === "beaten-pause") return ""; // transient hold before the table clears - nobody's "doing" anything
    if (seat === game.attackerSeat && (game.phase === "open" || game.phase === "wave")) return d.roleAttacking;
    if (seat === game.defenderSeat) return d.roleDefending;
    if (game.phase === "wave" && meta.passed) return d.rolePassed;
    return "";
  }

  // Shown from the moment MY OWN seat empties its hand with the reserve gone
  // (durakEngine.js's checkOutPlayers sets finishRank) until the whole game
  // actually ends (game.result) - the gap where I'm done playing but others
  // still are. realtime/durakRoomManager.js's payOutEarlyFinisher pays this
  // seat's Elo delta out the instant finishRank is set (no more waiting for
  // the rest of the table - see its own comment for why that's safe), so
  // once myEarlyRatingChange lands (a few tens of ms later, over its own
  // "ratingChanges" message) this shows the real number instead of a
  // "wait for the game to end" placeholder. Called both from renderTable()
  // (every roomState) and directly from the "ratingChanges" handler (so the
  // banner updates the instant the delta arrives, without waiting on the
  // next roomState from someone else's move).
  function updateEarlyFinishBanner(game) {
    const seat = game.you ? game.you.seat : null;
    const myFinishRank = seat != null ? game.players[seat].finishRank : null;
    // Not finished (yet, or a fresh game since the last time I was) - nothing
    // to show, and nothing worth remembering from a previous finish either.
    if (myFinishRank == null) myEarlyRatingChange = null;
    earlyFinishBannerEl.hidden = !(myFinishRank != null && !game.result);
    if (earlyFinishBannerEl.hidden) return;
    if (myEarlyRatingChange) {
      const sign = myEarlyRatingChange.delta > 0 ? "+" : "";
      earlyFinishBannerEl.textContent = fillTemplate(d.earlyFinishRatedTpl, { RANK: myFinishRank, DELTA: sign + myEarlyRatingChange.delta });
    } else {
      earlyFinishBannerEl.textContent = fillTemplate(d.earlyFinishTpl, { RANK: myFinishRank });
    }
  }

  function renderTable(room, game, justDealt) {
    if (!game) return;
    // Read by the local-redraw calls in renderHand()/showActionChoice()/the
    // table-loop below, which don't otherwise have access to this render's
    // room/game params (renderHand is a separate top-level function).
    lastRenderedRoom = room;
    lastRenderedGame = game;
    // A fresh roomState always supersedes whatever the beat-vs-transfer
    // chooser (if open) was about - e.g. the clock ran out mid-choice and the
    // server force-took the bout for them. Re-shown fresh if still relevant.
    hideActionChoice();
    // Spectator payloads have no game.you at all (durakEngine.js's
    // serializeForSpectator) - mySeat stays null, which the seat-order and
    // hand-panel logic below both treat as "showing every seat, no hand of my own".
    const mySeat = game.you ? game.you.seat : null;
    handPanelEl.hidden = mySeat == null;
    // Spectators (no seat of their own) can watch but not react - same gate
    // as the hand panel above.
    if (stickersEl) stickersEl.hidden = mySeat == null;

    // I'm done (finishRank set) but the game isn't over yet (others are still
    // playing, only possible with 3+ seats - see durakEngine.js's
    // checkOutPlayers) - say so now instead of leaving an empty hand looking
    // like nothing happened.
    updateEarlyFinishBanner(game);

    // Opponents: every other seat. Seated players see them starting from the
    // seat after their own, so the row reads left-to-right the way people are
    // seated around from you; a spectator (no seat of their own) just sees
    // every seat in table order. flex-nowrap in the markup (gameDurak.ejs)
    // keeps this to one row even at 6 players - each block below is sized
    // compact specifically so 5 opponents fit without wrapping to a second
    // row, which was confusing turn order at full tables.
    opponentsEl.textContent = "";
    const n = room.players.length;
    const seatOrder =
      mySeat != null
        ? Array.from({ length: n - 1 }, (_, i) => (mySeat + i + 1) % n)
        : Array.from({ length: n }, (_, i) => i);
    for (const seat of seatOrder) {
      const p = room.players[seat];
      const meta = game.players[seat];
      const isAttacker = seat === game.attackerSeat;
      const isDefender = seat === game.defenderSeat;
      const wrap = document.createElement("div");
      wrap.dataset.seat = String(seat);
      wrap.className =
        "flex flex-col items-center gap-0.5 px-1.5 py-1 rounded-lg border w-[4.5rem] sm:w-20 shrink-0 " +
        (isAttacker ? "border-purple-600 bg-purple-500/10" : isDefender ? "border-rose-600 bg-rose-500/10" : "border-neutral-800");
      const header = document.createElement("div");
      header.className = "flex items-center gap-1 max-w-full";
      // Rating (when known) moves to a tooltip instead of sitting inline next
      // to the name - the whole point of shrinking this block is fitting 5 of
      // them in one row, and "(1500)" next to every name undoes that.
      header.title = p.rating != null ? p.displayName + " (" + p.rating + ")" : p.displayName;
      header.appendChild(buildAvatarEl(p));
      const name = document.createElement("p");
      name.className = "text-[10px] truncate " + (p.connected ? "text-neutral-300" : "text-amber-500");
      // The disconnected/amber colour is a status signal, more useful than
      // the player's own chat colour in that moment - only apply their
      // colour while they're actually connected.
      if (p.connected && p.color) name.style.color = p.color;
      name.textContent = p.displayName + (meta.out ? " ✔" : p.left ? " ✗" : "");
      header.appendChild(name);
      const backs = document.createElement("div");
      backs.className = "flex";
      for (let c = 0; c < Math.min(meta.handCount, 6); c++) {
        const backEl = buildCardBackEl("w-4 h-6", c > 0 ? "-ml-2" : "");
        if (justDealt) dealInAnimate(backEl, c);
        backs.appendChild(backEl);
      }
      const count = document.createElement("p");
      count.className = "text-[9px] text-neutral-500 tabular-nums";
      count.textContent = String(meta.handCount);
      const roleEl = document.createElement("p");
      roleEl.className =
        "text-[9px] font-medium leading-tight h-3 " + (isAttacker ? "text-purple-400" : isDefender ? "text-rose-400" : "text-neutral-600");
      roleEl.textContent = seatRoleLabel(game, seat, meta);
      const clockBadge = document.createElement("p");
      clockBadge.className = "text-[9px] font-mono tabular-nums text-neutral-500";
      clockBadge.dataset.clockSeat = String(seat);
      clockBadge.title = d.timeRemainingTooltip;
      wrap.append(header, backs, count, roleEl, clockBadge);
      opponentsEl.appendChild(wrap);
    }

    deckEl.textContent = "";
    deckCountEl.textContent = String(game.deckCount);
    if (game.trumpCard) {
      // buildCardEl()'s own base class hardcodes w-14 h-20 - the trailing "!"
      // important-modifier (not just a plain override) is what actually makes
      // this shrink to w-10 h-14 instead of losing to the base size the same
      // way buildCardBackEl's opponent-row size once silently lost (see that
      // function's own comment).
      deckEl.appendChild(buildCardEl(game.trumpCard, "w-10! h-14! rotate-90"));
      deckEl.appendChild(buildCardBackEl("w-14 h-20"));
    }
    // Unlike the rotated trump card above (nothing left to show once the deck
    // itself is empty), this label stays up for the rest of the game -
    // trumpSuit is always sent regardless of deckCount (durakEngine.js's
    // serializeForSeat), unlike trumpCard which goes null once the deck runs out.
    trumpLabelEl.textContent = d.trumpLabel + ": " + SUIT_SYMBOL[game.trumpSuit];
    trumpLabelEl.className = "text-xs font-medium " + (isRed(game.trumpSuit) ? "text-red-500" : "text-neutral-300");

    // Table content just changed (a card was added, or the bout was cleared)
    // if the number of filled slots differs from last render - either way,
    // something visibly moved, so play the same "slide" sound durak.js (bot
    // mode) plays for every attack/defend/take. A fresh deal gets its own
    // "shuffle" sound instead, and always starts from a clean slate.
    const filledCount = game.table.reduce((sum, pair) => sum + 1 + (pair.defense ? 1 : 0), 0);
    const clearing = !justDealt && previousTableFilled > 0 && filledCount === 0;
    // Rescue the outgoing pair elements (still live in the DOM from the last
    // render) BEFORE tableCardsEl gets wiped below, so they can be reparented
    // and slid out instead of just disappearing with the wipe. A "take" clear
    // (pendingTakeSeat set) animates toward whoever took the table - their own
    // hand if it was me, otherwise their opponent block (already rebuilt above,
    // with the seat this game's cards are headed to) - a genuine "beaten"
    // discard (pendingTakeSeat null) keeps the default off-board slide.
    const oldPairEls = clearing ? Array.from(tableCardsEl.children) : null;
    const oldPairRects = oldPairEls ? oldPairEls.map((el) => el.getBoundingClientRect()) : null;
    const takeSeat = clearing ? pendingTakeSeat : null;
    pendingTakeSeat = null; // consumed - stale values must never leak into a later clear
    let clearTowardRect = null;
    if (takeSeat != null) {
      clearTowardRect =
        takeSeat === mySeat
          ? handEl.getBoundingClientRect()
          : opponentsEl.querySelector('[data-seat="' + takeSeat + '"]')?.getBoundingClientRect() || null;
    }

    if (justDealt) {
      previousTableFilled = 0;
      playSound("shuffle");
    } else if (filledCount !== previousTableFilled) {
      playSound("slide");
    }
    previousTableFilled = filledCount;

    tableCardsEl.textContent = "";
    game.table.forEach((pair, index) => {
      const wrap = document.createElement("div");
      // pendingDefendCard/pendingDefendIndices (set by renderHand()'s
      // ambiguous-defend branch or the multi-target beat-picker above): this
      // undefended pair is one of several the pending card could legally
      // beat, so it's a live click target instead of just a display.
      const isTarget = pendingDefendCard && !pair.defense && pendingDefendIndices.includes(index);
      wrap.className = "relative w-16 h-[5.5rem]" + (isTarget ? " ring-2 ring-rose-500 rounded-md cursor-pointer" : "");
      wrap.appendChild(positionAbsolute(buildCardEl(pair.attack), "top-0 left-0"));
      if (pair.defense) wrap.appendChild(positionAbsolute(buildCardEl(pair.defense), "top-2 left-2"));
      if (isTarget) {
        const card = pendingDefendCard;
        wrap.addEventListener("click", () => {
          pendingDefendCard = null;
          pendingDefendIndices = [];
          send({ type: "defend", tableIndex: index, card });
        });
      }
      tableCardsEl.appendChild(wrap);
    });

    if (oldPairEls) {
      for (let i = 0; i < oldPairEls.length; i++) animateTableExit(oldPairEls[i], oldPairRects[i], clearTowardRect);
    }

    if (game.you) renderHand(game, justDealt);
    renderStatusAndButtons(game);
    myClockEl.title = d.timeRemainingTooltip;
    renderClockDisplays(); // paint immediately - the 250ms interval alone would leave a blank flash

    if (game.result) {
      lastGame = game;
      showResult(room, game);
    } else {
      lastGame = null;
      lastRatingChanges = null;
      resultOverlayEl.hidden = true;
    }
  }

  function renderHand(game, justDealt) {
    handEl.textContent = "";
    const legal = game.legal;
    // legal.canTake is exactly "phase===defend && this is my seat's defend
    // turn" (server-scoped, see durakEngine.js's serializeForSeat) - a
    // precise "I'm defending right now" signal, unlike legal.defendable.length
    // which is also empty whenever the defender simply has no beatable card
    // for the current attack (still their turn to respond, just via Take).
    const isDefending = legal.canTake;
    game.you.hand.forEach((card, index) => {
      let isLegal = false;
      let onClick = null;
      if (legal.canOpen) {
        isLegal = true;
        onClick = () => send({ type: "open", card });
      } else if (isDefending) {
        const matchingEntries = legal.defendable.filter((entry) => entry.options.some((c) => cardsEqual(c, card)));
        const canTransferThis = (legal.transferCards || []).some((c) => cardsEqual(c, card));
        if (pendingDefendCard && cardsEqual(pendingDefendCard, card)) {
          // Already awaiting a table-target click for this exact card -
          // clicking it again cancels the pending pick instead of restarting it.
          isLegal = true;
          onClick = () => {
            pendingDefendCard = null;
            pendingDefendIndices = [];
            renderTable(lastRenderedRoom, lastRenderedGame, false);
          };
        } else if (matchingEntries.length > 1 && !canTransferThis) {
          // Can beat several undefended cards but transfer isn't in play at
          // all - no real ambiguity to ask about, just go straight to
          // table-click targeting (see renderTable()'s table-loop below).
          isLegal = true;
          onClick = () => {
            pendingDefendCard = card;
            pendingDefendIndices = matchingEntries.map((e) => e.index);
            renderTable(lastRenderedRoom, lastRenderedGame, false);
          };
        } else if (matchingEntries.length >= 1 && canTransferThis) {
          // Ambiguous: transfer is a genuine alternative to beating (whether
          // there's exactly one card this could beat, or several) - ask
          // instead of guessing.
          isLegal = true;
          onClick = () => showActionChoice(card, matchingEntries, canTransferThis);
        } else if (matchingEntries.length === 1) {
          isLegal = true;
          onClick = () => send({ type: "defend", tableIndex: matchingEntries[0].index, card });
        } else if (canTransferThis) {
          isLegal = true;
          onClick = () => send({ type: "transfer", card });
        }
      } else if (legal.canThrowIn.some((c) => cardsEqual(c, card))) {
        isLegal = true;
        onClick = () => send({ type: "throwIn", card });
      }
      // Enlarges the clickable area beyond the painted 56x80 card, biased
      // upward - same "expand touch target" ::before trick as durak.js's
      // renderPlayerHand(), see that comment. gap-2 on #dmp-hand (see
      // gameDurak.ejs) keeps neighboring cards' expanded areas from overlapping.
      const isPendingThisCard = pendingDefendCard && cardsEqual(pendingDefendCard, card);
      const el = buildCardEl(
        card,
        isLegal
          ? "cursor-pointer hover:-translate-y-2 transition-transform before:content-[''] before:absolute before:-top-2 before:-left-1 before:-right-1 before:-bottom-1" +
              (isPendingThisCard ? " -translate-y-2 ring-2 ring-rose-500 rounded-md" : "")
          : "opacity-40 pointer-events-none"
      );
      if (isLegal) el.addEventListener("click", onClick);
      if (justDealt) dealInAnimate(el, index);
      handEl.appendChild(el);
    });
  }

  // --- Beat-vs-transfer chooser ---------------------------------------------
  // Shown whenever transfer is a real alternative to beating for the clicked
  // card (a trump matching the table's rank - see durakEngine.js's
  // canTransfer()) - whether it can beat exactly one undefended table card or
  // several at once (a trump beats every non-trump attack regardless of rank,
  // and several same-rank attacks can sit undefended together - see
  // renderHand() below). Pure multi-target-with-no-transfer skips this
  // modal entirely and goes straight to table-click targeting instead (see
  // renderHand()'s matchingEntries.length > 1 && !canTransferThis branch).
  let pendingChoiceCard = null;
  let pendingChoiceEntries = [];

  function showActionChoice(card, defendEntries, canTransfer) {
    pendingChoiceCard = card;
    pendingChoiceEntries = defendEntries;
    choiceTransferBtn.hidden = !canTransfer;
    actionChoicePromptEl.textContent =
      defendEntries.length > 1 ? actionChoiceEl.dataset.promptTarget : actionChoiceEl.dataset.promptTransfer;
    actionChoiceEl.hidden = false;
  }
  function hideActionChoice() {
    actionChoiceEl.hidden = true;
    pendingChoiceCard = null;
    pendingChoiceEntries = [];
  }
  choiceBeatBtn.addEventListener("click", () => {
    if (!pendingChoiceCard || !pendingChoiceEntries.length) {
      hideActionChoice();
      return;
    }
    if (pendingChoiceEntries.length === 1) {
      send({ type: "defend", tableIndex: pendingChoiceEntries[0].index, card: pendingChoiceCard });
      hideActionChoice();
    } else {
      // Still ambiguous even with transfer ruled out - hand off to
      // table-click targeting (see renderTable()'s table-loop below) instead
      // of guessing which of several undefended cards was meant.
      pendingDefendCard = pendingChoiceCard;
      pendingDefendIndices = pendingChoiceEntries.map((e) => e.index);
      hideActionChoice();
      renderTable(lastRenderedRoom, lastRenderedGame, false);
    }
  });
  choiceTransferBtn.addEventListener("click", () => {
    if (pendingChoiceCard) send({ type: "transfer", card: pendingChoiceCard });
    hideActionChoice();
  });

  // --- Multi-target beat picker ----------------------------------------------
  // Set once the player has committed to beating (not transferring) a card
  // that can legally cover more than one undefended table card - the specific
  // table card is then chosen by clicking it directly (see renderTable()'s
  // table-loop and renderHand()'s cancel-by-reclicking below), so the actual
  // click target lives on the board, not in a modal that would have to cover
  // (and thus block clicks on) the very cards being chosen between.
  let pendingDefendCard = null;
  let pendingDefendIndices = [];
  let lastRenderedRoom = null;
  let lastRenderedGame = null;

  function renderStatusAndButtons(game) {
    if (!game.legal) {
      // Spectator payload (durakEngine.js's serializeForSpectator never
      // includes "legal" - it's meaningless without a seat of your own).
      // Nothing to press, and each opponent block already spells out its own
      // role (see seatRoleLabel above), so the central status line stays blank.
      takeBtn.hidden = true;
      passBtn.hidden = true;
      statusEl.textContent = "";
      return;
    }
    takeBtn.hidden = !game.legal.canTake;
    passBtn.hidden = !game.legal.canPass;
    if (game.result) {
      statusEl.textContent = "";
      return;
    }
    if (pendingDefendCard) statusEl.textContent = d.statusChooseTarget;
    else if (game.legal.canOpen) statusEl.textContent = d.statusAttack;
    else if (game.legal.defendable.length) statusEl.textContent = d.statusDefend;
    else if (game.legal.canThrowIn.length || game.legal.canPass) statusEl.textContent = d.statusThrowin;
    else statusEl.textContent = d.statusWaiting;
  }

  takeBtn.addEventListener("click", () => send({ type: "take" }));
  passBtn.addEventListener("click", () => send({ type: "passThrowIn" }));

  function showResult(room, game) {
    resultOverlayEl.hidden = false;
    const result = game.result;
    const mySeat = game.you ? game.you.seat : null; // null for a spectator - every "was this me" check below then just falls through to the displayName branch
    resultDetailEl.textContent = "";
    if (result.kind === "durak") {
      resultTitleEl.textContent = d.titleDurak;
      const loser = room.players[result.loserSeat];
      resultDetailEl.textContent = d.durakLoserLabel + " " + (loser ? loser.displayName : "?");
    } else if (result.kind === "left-early-win") {
      // Title states WHO left/timed out and HOW, by name - true from every
      // seat's point of view (unlike the old fixed "opponents left, you win"
      // text, which every viewer saw verbatim, including the very player who
      // was just forfeited and lost points over it). The winner is still
      // named explicitly below, same as every other result kind.
      const loser = room.players[result.loserSeat];
      const name = result.loserSeat === mySeat ? d.youLabel : loser ? loser.displayName : "?";
      const tpl = result.reason === "clock" ? d.actionTimeoutTpl : d.leftResultTitleTpl;
      resultTitleEl.textContent = fillTemplate(tpl, { NAME: name });
      const winner = room.players[result.winnerSeat];
      resultDetailEl.textContent = d.winnerLabel + " " + (winner ? winner.displayName : "?");
    } else {
      resultTitleEl.textContent = d.titleDraw;
    }

    renderStandings(room, game);
  }

  // Renders the post-game standings list. Before "ratingChanges" has arrived,
  // falls back to just the seats that actually finished (the original
  // behavior); once it lands, uses it instead - it covers every seat
  // (including the durak and anyone who quit) in the right order and carries
  // each seat's Elo delta, which finishRank alone can't express.
  function renderStandings(room, game) {
    resultStandingsEl.textContent = "";
    const nameOf = (seat) => (room.players[seat] ? room.players[seat].displayName : "?");

    if (lastRatingChanges) {
      const ordered = lastRatingChanges.slice().sort((a, b) => a.place - b.place);
      for (const entry of ordered) {
        const li = document.createElement("li");
        const finishRank = game.players[entry.seat] && game.players[entry.seat].finishRank;
        const label = finishRank != null ? fillTemplate(d.finishRankTpl, { RANK: finishRank }) : d.standingsEliminatedLabel;
        const sign = entry.delta > 0 ? "+" : "";
        li.textContent = label + ": " + nameOf(entry.seat) + " (" + sign + entry.delta + ")";
        resultStandingsEl.appendChild(li);
      }
      return;
    }

    const ranked = game.players
      .map((p, seat) => ({ seat, finishRank: p.finishRank }))
      .filter((p) => p.finishRank != null)
      .sort((a, b) => a.finishRank - b.finishRank);
    for (const entry of ranked) {
      const li = document.createElement("li");
      li.textContent = fillTemplate(d.finishRankTpl, { RANK: entry.finishRank }) + ": " + nameOf(entry.seat);
      resultStandingsEl.appendChild(li);
    }
  }

  // --- Boot --------------------------------------------------------------------
  // /games/durak now hosts both modes on one page (public/js/games/durak-mode-
  // select.js) - this script's markup starts hidden inside the "people"
  // section, so opening the WebSocket must wait until the visitor actually
  // picks that mode (mode-select dispatches "durak:play-people"), except for a
  // room deep link (d.autoJoinRoomId set server-side), which should connect
  // immediately since the whole point of that URL is joining a room.

  if (d.autoJoinRoomId) {
    connect();
  } else {
    document.addEventListener("durak:play-people", connect, { once: true });
  }
  window.addEventListener("beforeunload", () => {
    deliberateClose = true;
  });
})();
