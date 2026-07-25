// /games/sunduchki's real-time client. Unlike a client-authoritative game,
// this renders whatever realtime/sunduchkiRoomManager.js pushes over the
// WebSocket and never computes game rules itself - every action it sends is
// just a request the server may reject (an "error" message comes back,
// rendered as a toast). Structurally cloned from durak-multiplayer.js's
// connection/lobby/room/ready-check plumbing, simplified for Sunduchki's
// single-active-seat "ask" turn (no bout phases, no per-card table state).
(function () {
  "use strict";

  const root = document.getElementById("skp-root");
  if (!root) return;

  const d = root.dataset;
  const myUserId = d.myUserId;

  // Cross-game spectator hub embed (public/js/games/watch-hub.js): when set,
  // this page is inside the hub's iframe to auto-watch one room and must
  // report back when that game ends so the hub can auto-advance.
  const embedWatchRoomId = d.watchRoomId || null;
  let embedEnded = false;
  let embedStarted = false;
  let embedWatchdog = null;

  function embedClearWatchdog() {
    if (embedWatchdog) {
      clearTimeout(embedWatchdog);
      embedWatchdog = null;
    }
  }

  function embedPostEnded() {
    if (!embedWatchRoomId || embedEnded) return;
    embedEnded = true;
    embedClearWatchdog();
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "spectatorMatchEnded", roomId: embedWatchRoomId }, location.origin);
      }
    } catch (_) {
      /* same-origin iframe - shouldn't throw */
    }
  }

  // See durak-multiplayer.js's identical block for the full rationale: only
  // the hub's iframe (not a `?watch=` link opened directly in a normal tab)
  // has no left margin of its own, so this page's local spectator cluster/
  // picker must stay suppressed there in favor of the hub's own instance.
  const isHubEmbed = !!(embedWatchRoomId && window.parent && window.parent !== window);

  function postSpectatorEmoteState(room, yourEmoteId, spectating) {
    if (!isHubEmbed) return;
    try {
      window.parent.postMessage(
        {
          type: "spectatorEmoteState",
          roomId: embedWatchRoomId,
          spectatorEmotes: room.spectatorEmotes || [],
          yourEmoteId: yourEmoteId || null,
          isSpectating: !!spectating,
        },
        location.origin
      );
    } catch (_) {
      /* same-origin iframe - shouldn't throw */
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (msg && msg.type === "setSpectatorEmote" && embedWatchRoomId) {
      send({ type: "setSpectatorEmote", emoteId: msg.emoteId });
    }
  });

  // Same card-rendering convention as durak-multiplayer.js (no image
  // sprites - every card is a small styled div built from {suit, rank}).
  const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
  const SUIT_ORDER = ["S", "H", "D", "C"]; // fixed display order for the suit picker
  const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };

  function rankLabel(rank) {
    return RANK_LABEL[rank] || String(rank);
  }
  function isRed(suit) {
    return suit === "H" || suit === "D";
  }

  function buildCardEl(rank, suit, extraClass) {
    const el = document.createElement("div");
    el.className =
      "relative w-14 h-20 rounded-md bg-neutral-100 border border-neutral-300 shadow-sm shrink-0" +
      (extraClass ? " " + extraClass : "");
    const colorClass = suit && isRed(suit) ? "text-red-600" : "text-neutral-900";
    const label = rankLabel(rank);
    const topLeft = document.createElement("span");
    topLeft.className = "absolute top-1 left-1.5 text-xs font-bold leading-tight " + colorClass;
    topLeft.textContent = label;
    const center = document.createElement("span");
    center.className = "absolute inset-0 grid place-items-center text-xl " + colorClass;
    center.textContent = suit ? SUIT_SYMBOL[suit] : "";
    el.append(topLeft, center);
    return el;
  }

  // sizeClass is required, not optional - same Tailwind cascade gotcha
  // durak-multiplayer.js's own buildCardBackEl documents: "relative" (baked
  // into buildCardEl's base class) always wins the position: cascade over a
  // later "absolute" utility regardless of source order, so a hardcoded
  // default size here would silently outrank whatever a caller passes.
  function buildCardBackEl(sizeClass, extraClass) {
    const el = document.createElement("div");
    el.className =
      sizeClass + " rounded-md border-2 border-purple-950 shrink-0 bg-purple-800 ring-1 ring-inset ring-purple-500/40" +
      (extraClass ? " " + extraClass : "");
    return el;
  }

  const CHEST_ICON_SRC = "/images/games/sunduchki/chest.png";

  // The game's namesake icon (a collected "chest" of 4-of-a-kind) - used in
  // place of a 📦 emoji everywhere a chest count is shown, so it's a real
  // asset instead of relying on the viewer's emoji font.
  function buildChestIconEl(sizeClass) {
    const img = document.createElement("img");
    img.src = CHEST_ICON_SRC;
    img.alt = "";
    img.className = (sizeClass || "w-3.5 h-3.5") + " inline-block shrink-0 align-middle object-contain";
    return img;
  }

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

  // --- Sound -----------------------------------------------------------------
  // Same cloneNode()-per-play pattern as durak-multiplayer.js (lets overlapping
  // plays layer instead of cutting each other off) and the same 3 sound files
  // (shared drop-in assets, not Sunduchki-specific recordings) reused under
  // this game's own sounds folder.
  const SOUND_BASE = "/sounds/games/sunduchki/";
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
      node.volume = base.volume * (window.gameVolume ? window.gameVolume.get() : 1);
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the game keeps working silently */
    }
  }

  // --- Card animation ----------------------------------------------------------
  // Same Web Animations API technique as durak-multiplayer.js's dealInAnimate:
  // no persistent per-card DOM identity here either (every roomState fully
  // rebuilds the hand/opponents), so animation is applied fresh to whichever
  // elements a render pass just created, staggered by index.
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

  // A single newly-arrived card (won via a hit, or drawn from the deck) -
  // shorter/snappier than the full deal, no stagger needed for one card.
  function popInAnimate(el) {
    if (!el.animate) return;
    el.animate(
      [
        { transform: "scale(0.6)", opacity: 0 },
        { transform: "scale(1.08)", opacity: 1, offset: 0.7 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  }

  // The payoff moment - a rank fully collected into a chest. A quick
  // amber flash + bounce on whichever badge just updated.
  function chestFlourishAnimate(el) {
    if (!el.animate) return;
    el.animate(
      [
        { transform: "scale(1)", filter: "brightness(1)" },
        { transform: "scale(1.5)", filter: "brightness(1.6)", offset: 0.5 },
        { transform: "scale(1)", filter: "brightness(1)" },
      ],
      { duration: 600, easing: "ease-out" }
    );
  }

  // --- DOM refs ----------------------------------------------------------------

  const connStatusEl = document.getElementById("skp-connstatus");
  const lobbyViewEl = document.getElementById("skp-lobby-view");
  const roomViewEl = document.getElementById("skp-room-view");
  const roomListEl = document.getElementById("skp-room-list");
  const roomListEmptyEl = document.getElementById("skp-room-list-empty");
  const createRoomBtn = document.getElementById("skp-create-room-btn");
  const playingListEl = document.getElementById("skp-playing-list");
  const playingListEmptyEl = document.getElementById("skp-playing-list-empty");

  const roomCodeEl = document.getElementById("skp-room-code");
  const copyLinkBtn = document.getElementById("skp-copy-link-btn");
  const spectatorCountEl = document.getElementById("skp-spectator-count");
  const spectatorCluster = window.initSpectatorCluster ? window.initSpectatorCluster() : { update: function () {} };
  const spectatorEmotePicker = window.initSpectatorEmotePicker
    ? window.initSpectatorEmotePicker({ onSelect: function (emoteId) { send({ type: "setSpectatorEmote", emoteId: emoteId }); } })
    : { show: function () {}, hide: function () {}, setSelected: function () {} };
  const avgRatingEl = document.getElementById("skp-avg-rating");
  const spectatingBadgeEl = document.getElementById("skp-spectating-badge");
  const startBtn = document.getElementById("skp-start-btn");
  const leaveBtn = document.getElementById("skp-leave-btn");
  const stopWatchingBtn = document.getElementById("skp-stop-watching-btn");
  const playerListEl = document.getElementById("skp-player-list");
  const waitingHintEl = document.getElementById("skp-waiting-hint");

  const rulesPanelEl = document.getElementById("skp-rules-panel");
  const ruleDeckSizeEl = document.getElementById("skp-rule-deck-size");
  const ruleQuestionTargetEl = document.getElementById("skp-rule-question-target");
  const rulesHostHintEl = document.getElementById("skp-rules-host-hint");
  const rulesSummaryEl = document.getElementById("skp-rules-summary");

  const readyCheckEl = document.getElementById("skp-ready-check");
  const readyCountdownEl = document.getElementById("skp-ready-countdown");
  const readyCountEl = document.getElementById("skp-ready-count");
  const readyAcceptBtn = document.getElementById("skp-ready-accept-btn");
  const readyWaitingEl = document.getElementById("skp-ready-waiting");

  const tableWrapEl = document.getElementById("skp-table-wrap");
  const boardEl = document.getElementById("skp-board");
  const opponentsEl = document.getElementById("skp-opponents");
  const deckEl = document.getElementById("skp-deck");
  const deckCountEl = document.getElementById("skp-deck-count");
  const statusEl = document.getElementById("skp-status");
  const targetPickerEl = document.getElementById("skp-target-picker");
  const targetPickerLabelEl = document.getElementById("skp-target-picker-label");
  const targetButtonsEl = document.getElementById("skp-target-buttons");
  const suitPickerEl = document.getElementById("skp-suit-picker");
  const suitPickerLabelEl = document.getElementById("skp-suit-picker-label");
  const suitButtonsEl = document.getElementById("skp-suit-buttons");
  const handPanelEl = document.getElementById("skp-hand-panel");
  const myClockEl = document.getElementById("skp-my-clock");
  const handEl = document.getElementById("skp-hand");
  const myChestsEl = document.getElementById("skp-my-chests");
  const myChestsCountEl = document.getElementById("skp-my-chests-count");

  const resultOverlayEl = document.getElementById("skp-result-overlay");
  const resultTitleEl = document.getElementById("skp-result-title");
  const resultDetailEl = document.getElementById("skp-result-detail");
  const resultStandingsEl = document.getElementById("skp-result-standings");
  const resultBackBtn = document.getElementById("skp-result-back-btn");

  // --- Connection --------------------------------------------------------------

  let ws = null;
  let reconnectAttempt = 0;
  let deliberateClose = false;
  let currentRoomId = null;
  let lastRoom = null;
  let mySeat = null;
  let isSpectating = false;
  let lastGame = null;
  let lastRatingChanges = null;
  let previousLobbyPlayerIds = null;
  let previousLobbyPlayerRoomId = null;
  // The rank picked from my own hand this turn - cleared on every fresh
  // roomState (a new turn/game) and once the ask is actually sent.
  let selectedRank = null;
  // Suit(s) picked for that rank (step 2 of the ask) - a Set, cleared
  // alongside selectedRank.
  let selectedSuits = new Set();
  // Guards passEmpty from firing more than once for the same "nothing to ask
  // with" turn - reset whenever the active seat or my hand size changes.
  let autoPassSignature = null;
  let autoPassTimer = null;

  // --- Animation/sound diff tracking ------------------------------------------
  // renderTable() diffs each render against these to decide what's NEW since
  // last time (a card gained, a chest completed) - reset together whenever a
  // fresh game is dealt (see renderRoom's justDealt) so a brand new game's
  // first render never treats its full starting hand as "newly arrived" cards.
  let previousHandKeys = null; // Set of "suit-rank" strings, my own hand only
  let previousChestCounts = null; // seat -> chest count, every seat
  let previousLastLogKey = null; // JSON of the last-seen game.log entry - see renderTable's logEntryKey diffing
  let readyCheckSoundPlayedFor = null; // dedupes the notification sound against the ready check's deadline value

  function cardKey(card) {
    return card.suit + "-" + card.rank;
  }

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
      if (embedWatchRoomId) send({ type: "watchRoom", roomId: embedWatchRoomId });
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
      if (embedWatchRoomId && embedStarted) embedPostEnded();
    } else if (msg.type === "roomState") {
      currentRoomId = msg.room.id;
      isSpectating = !!msg.spectating;
      renderRoom(msg);
      if (embedWatchRoomId) {
        embedStarted = true;
        embedClearWatchdog();
        if (msg.game && msg.game.result && !embedEnded) setTimeout(embedPostEnded, 4000);
      }
    } else if (msg.type === "playerLeft") {
      narratePlayerLeft(msg.seat, msg.reason);
    } else if (msg.type === "kicked") {
      resetRoomUiState();
      showToast(d.kickedToast);
    } else if (msg.type === "ratingChanges") {
      lastRatingChanges = msg.changes;
      if (lastRoom && lastGame && !resultOverlayEl.hidden) renderStandings(lastRoom, lastGame);
    } else if (msg.type === "error") {
      if (embedWatchRoomId && (msg.code === "room-not-found" || msg.code === "room-not-watchable")) {
        embedPostEnded();
        return;
      }
      showToast(errorText(msg.code));
    }
  }

  function narratePlayerLeft(seat, reason) {
    const player = lastRoom && lastRoom.players[seat];
    const name = seat === mySeat ? d.youLabel : player ? player.displayName : "?";
    const tpl =
      {
        leave: d.actionLeftTpl,
        disconnect: d.actionDisconnectTpl,
        timeout: d.actionTimeoutTpl,
        clock: d.actionClockTpl,
        kicked: d.actionKickedTpl,
      }[reason] || d.actionLeftTpl;
    const text = fillTemplate(tpl, { NAME: name });
    // A seat still on the table gets the badge anchored over its own
    // nameplate, same as every other action; a seat that's already gone from
    // lastRoom entirely (or if this client isn't seated/watching this room
    // at all) falls back to the generic status-line toast.
    if (lastRoom && lastRoom.players[seat] && (seat === mySeat || opponentsEl.querySelector('[data-seat="' + seat + '"]'))) {
      showActionBadge(seat, text, "bg-amber-900/90 text-amber-100");
    } else {
      showToast(text);
    }
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
      "spectator-emote-rate-limited": d.errSpectatorEmoteRateLimited,
      "not-in-lobby": d.errNotInLobby,
      "player-not-found": d.errPlayerNotFound,
      "not-your-turn": d.errNotYourTurn,
      "rank-not-legal": d.errRankNotLegal,
      "target-not-allowed": d.errTargetNotAllowed,
      "bad-target": d.errTargetNotAllowed,
    };
    return map[code] || d.errGeneric;
  }

  function showToast(text) {
    if (!roomViewEl.hidden && !tableWrapEl.hidden) {
      statusEl.dataset.toast = text;
      statusEl.textContent = text;
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => {
        if (statusEl.dataset.toast === text) renderStatus(lastRoom, lastGame);
      }, 3000);
    } else {
      setConnStatus(text);
      setTimeout(() => setConnStatus(""), 4000);
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

  // --- Lobby rendering -----------------------------------------------------

  function renderLobbyList(rooms) {
    if (currentRoomId) return;
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

  function renderPlayingList(rooms) {
    if (currentRoomId) return;
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

      li.append(info);
      playingListEl.appendChild(li);
    }
  }

  // --- Ready check ---------------------------------------------------------

  let readyCheckDeadline = null;
  let readyCheckTickHandle = null;

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
    // A fresh ready check (new deadline - a previous one lapsed/was
    // cancelled and Start was clicked again) gets the notification sound
    // once; re-renders of the SAME check (accept counts ticking up) must not
    // replay it.
    if (readyCheckSoundPlayedFor !== rc.deadline) {
      readyCheckSoundPlayedFor = rc.deadline;
      playSound("notification");
    }
    ensureReadyCheckTicking();
    renderReadyCountdown();
  }

  readyAcceptBtn.addEventListener("click", () => {
    send({ type: "acceptStart" });
    readyAcceptBtn.blur();
  });

  // --- Game rules: host-editable form in the lobby, one-line recap in-game -
  // Same split as durak-multiplayer.js's renderRulesPanel: the full form is
  // lobby-only, and #skp-rules-summary takes over as a compact line once
  // "playing" starts, so the board (now first in the DOM - see the comment
  // on #skp-table-wrap in gameSunduchki.ejs) doesn't sit behind a full
  // re-rendering of the settled ruleset.

  function renderRulesPanel(rules, amHost, roomStatus) {
    rulesPanelEl.hidden = roomStatus !== "lobby";
    rulesSummaryEl.hidden = roomStatus !== "playing";
    if (!rules) return;
    const editable = amHost && roomStatus === "lobby";
    ruleDeckSizeEl.value = String(rules.deckSize || "36");
    ruleDeckSizeEl.disabled = !editable;
    ruleQuestionTargetEl.value = rules.questionTarget || "next";
    ruleQuestionTargetEl.disabled = !editable;
    rulesHostHintEl.hidden = editable || roomStatus !== "lobby";

    if (roomStatus === "playing") {
      const rd = rulesSummaryEl.dataset;
      const deck = String(rules.deckSize) === "52" ? rd.deck52 : rd.deck36;
      const target = rules.questionTarget === "any" ? rd.targetAny : rd.targetNext;
      rulesSummaryEl.textContent = rd.label + " " + [deck, target].join(" · ");
    }
  }

  ruleDeckSizeEl.addEventListener("change", () => {
    send({ type: "setRules", rules: { deckSize: ruleDeckSizeEl.value } });
  });
  ruleQuestionTargetEl.addEventListener("change", () => {
    send({ type: "setRules", rules: { questionTarget: ruleQuestionTargetEl.value } });
  });

  // --- Per-player time budget (chess-clock style) -----------------------------
  // Directly ported from durak-multiplayer.js's own clock section: the server
  // only sends a fresh {remainingMs, runningSeats, serverNow} snapshot when
  // something actually happens, not continuously - this client interpolates
  // locally between snapshots so the displayed numbers still count down
  // smoothly. myClockEl.title is set once at boot (see Boot section below);
  // opponent clock badges are (re)built fresh every render inside
  // renderOpponents, same as everything else there.
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

  // --- Action badges over nicknames --------------------------------------------
  // Adapted from durak-multiplayer.js's showSticker(): anchors a small text
  // pill over whoever the action is about via getBoundingClientRect, the same
  // seat===mySeat -> handPanelEl / else -> opponentsEl's [data-seat] lookup.
  // Replaces the old scrolling #skp-log entirely - every ask/hit/miss/pass/
  // leave narrates itself over the acting seat's own nameplate instead.
  const ACTION_BADGE_MS = 1400;

  function showActionBadge(seat, text, colorClass) {
    const anchor = seat === mySeat ? handPanelEl : opponentsEl.querySelector('[data-seat="' + seat + '"]');
    if (!anchor || !boardEl) return;
    const anchorRect = anchor.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();
    // The horizontal-centering translateX(-50%) has to live on a separate,
    // never-animated wrapper: the sunduchki-action-pop CSS class below also
    // animates `transform` (for the pop/rise motion), and an animated
    // `transform` always wins over whatever was set inline on the SAME
    // element, silently dropping the centering for the animation's duration.
    const wrap = document.createElement("div");
    wrap.className = "absolute pointer-events-none";
    wrap.style.left = anchorRect.left - boardRect.left + anchorRect.width / 2 + "px";
    wrap.style.top = anchorRect.top - boardRect.top - 28 + "px";
    wrap.style.transform = "translateX(-50%)";
    wrap.style.zIndex = "30";
    const badge = document.createElement("span");
    badge.className =
      "sunduchki-action-pop block px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap shadow-lg " +
      (colorClass || "bg-neutral-800 text-neutral-100");
    badge.textContent = text;
    wrap.appendChild(badge);
    boardEl.appendChild(wrap);
    setTimeout(() => wrap.remove(), ACTION_BADGE_MS);
  }

  // --- Room rendering ------------------------------------------------------

  function switchView(inRoom) {
    lobbyViewEl.hidden = inRoom;
    roomViewEl.hidden = !inRoom;
    if (!inRoom) {
      spectatorCluster.update(0);
      spectatorEmotePicker.hide();
    }
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
    if (isHubEmbed) {
      postSpectatorEmoteState(room, msg.yourEmoteId, isSpectating);
    } else {
      spectatorCluster.update(room.spectatorEmotes && room.spectatorEmotes.length ? room.spectatorEmotes : room.spectatorCount || 0);
      if (isSpectating) spectatorEmotePicker.show(msg.yourEmoteId);
      else spectatorEmotePicker.hide();
    }
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
      startBtn.hidden = true;
      waitingHintEl.hidden = true;
      tableWrapEl.hidden = true;
      clocksSnapshot = null;
      stopClockTicking();
      renderReadyCheck(msg.readyCheck);
    } else {
      readyCheckEl.hidden = true;
      stopReadyCheckTicking();
      startBtn.hidden = true;
      waitingHintEl.hidden = true;
      // tableWrapEl is only ever hidden while status is "lobby"/"starting" -
      // the moment this branch first runs for a room is the moment it just
      // got dealt (a room plays exactly one game), same detection durak-
      // multiplayer.js uses for its own deal-in animation/shuffle sound.
      const justDealt = tableWrapEl.hidden;
      tableWrapEl.hidden = false;
      mySeat = msg.game && msg.game.you ? msg.game.you.seat : null;
      clocksSnapshot = msg.clocks || null;
      renderTable(room, msg.game, justDealt);
      if (msg.game && msg.game.result) stopClockTicking(); // game over - the snapshot is now static, no need to keep polling
      else ensureClockTicking();
    }
  }

  function resetRoomUiState() {
    currentRoomId = null;
    isSpectating = false;
    mySeat = null;
    selectedRank = null;
    selectedSuits = new Set();
    clocksSnapshot = null;
    stopClockTicking();
    stopReadyCheckTicking();
    readyCheckSoundPlayedFor = null;
    previousLobbyPlayerIds = null;
    previousLobbyPlayerRoomId = null;
    previousHandKeys = null;
    previousChestCounts = null;
    previousLastLogKey = null;
    switchView(false);
  }

  startBtn.addEventListener("click", () => {
    send({ type: "startGame" });
    startBtn.blur();
  });
  leaveBtn.addEventListener("click", () => {
    const game = lastGame;
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
    const url = location.origin + "/games/sunduchki/room/" + roomCodeEl.textContent;
    navigator.clipboard?.writeText(url).then(() => showToast(d.linkCopied)).catch(() => {});
  });

  // --- Table rendering -----------------------------------------------------

  function renderOpponents(room, game, justDealt, chestCountsBefore) {
    opponentsEl.textContent = "";
    const n = room.players.length;
    const seatOrder = [];
    const start = mySeat != null ? mySeat : 0;
    for (let i = 0; i < n; i++) {
      const seat = (start + i) % n;
      if (seat === mySeat) continue;
      seatOrder.push(seat);
    }
    for (const seat of seatOrder) {
      const p = room.players[seat];
      const meta = game.players[seat];
      if (!p || !meta) continue;
      const block = document.createElement("div");
      block.dataset.seat = String(seat);
      const isActive = seat === game.activeSeat && game.phase === "playing";
      block.className =
        "flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 min-w-[72px] " +
        (meta.left
          ? "border-neutral-800 opacity-50"
          : isActive
            ? "border-purple-500 bg-purple-500/10"
            : "border-neutral-800 bg-neutral-900/60");
      const nameRow = document.createElement("div");
      nameRow.className = "flex items-center gap-1";
      nameRow.appendChild(buildAvatarEl(p));
      const nameSpan = document.createElement("span");
      nameSpan.className = "text-xs text-neutral-200 truncate max-w-[64px]";
      nameSpan.textContent = p.displayName;
      nameRow.appendChild(nameSpan);
      // Stacked card-backs (ported from durak-multiplayer.js's own opponent
      // hand rendering) instead of a bare "N 🂠" text count.
      const backs = document.createElement("div");
      backs.className = "flex";
      for (let c = 0; c < Math.min(meta.handCount, 6); c++) {
        const backEl = buildCardBackEl("w-4 h-6", c > 0 ? "-ml-2" : "");
        if (justDealt) dealInAnimate(backEl, c);
        backs.appendChild(backEl);
      }
      const handCountSpan = document.createElement("span");
      handCountSpan.className = "text-[9px] text-neutral-500 tabular-nums";
      handCountSpan.textContent = String(meta.handCount);
      const chestsSpan = document.createElement("span");
      chestsSpan.className = "flex items-center gap-0.5 text-[11px] text-amber-400 tabular-nums";
      chestsSpan.hidden = meta.chests.length === 0;
      if (meta.chests.length) {
        chestsSpan.append(buildChestIconEl("w-3 h-3"), document.createTextNode("×" + meta.chests.length));
      }
      const clockBadge = document.createElement("p");
      clockBadge.className = "text-[9px] font-mono tabular-nums text-neutral-500";
      clockBadge.dataset.clockSeat = String(seat);
      clockBadge.title = d.timeRemainingTooltip;
      block.append(nameRow, backs, handCountSpan, chestsSpan, clockBadge);
      // Clickable as a target once a rank AND at least one suit are picked
      // and this seat is a legal target for my ask (server re-validates
      // regardless).
      if (
        !isSpectating &&
        mySeat === game.activeSeat &&
        selectedRank != null &&
        selectedSuits.size > 0 &&
        game.legal &&
        game.legal.targets.includes(seat)
      ) {
        block.classList.add("cursor-pointer", "ring-2", "ring-cyan-400", "hover:bg-cyan-500/10");
        block.addEventListener("click", () => {
          send({ type: "ask", targetSeat: seat, rank: selectedRank, suits: [...selectedSuits] });
          selectedRank = null;
          selectedSuits = new Set();
        });
      }
      opponentsEl.appendChild(block);
      // The payoff flourish - this seat's chest count just went up since the
      // last render (never on the very first, fresh-deal render, when every
      // count is trivially "up" from nothing).
      if (!justDealt && chestCountsBefore && meta.chests.length > (chestCountsBefore.get(seat) || 0)) {
        chestFlourishAnimate(chestsSpan);
      }
    }
  }

  function renderHand(game, justDealt, chestCountsBefore) {
    handPanelEl.hidden = mySeat == null || isSpectating;
    handEl.textContent = "";
    if (mySeat == null || !game.you) return;

    const myMeta = game.players[mySeat];
    const myChests = myMeta ? myMeta.chests.length : 0;
    myChestsEl.hidden = myChests === 0;
    myChestsCountEl.textContent = String(myChests);
    if (!justDealt && chestCountsBefore && myChests > (chestCountsBefore.get(mySeat) || 0)) {
      chestFlourishAnimate(myChestsEl);
    }

    const sortMode = window.handSortMode ? window.handSortMode.get() : "suit";
    const hand = game.you.hand.slice().sort(
      sortMode === "rank"
        ? (a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit)
        : (a, b) => a.suit.localeCompare(b.suit) || a.rank - b.rank
    );
    const legalRanks = new Set(game.legal ? game.legal.askRanks : []);
    const canPickThisTurn = mySeat === game.activeSeat && game.phase === "playing" && game.legal && game.legal.canAsk;
    const currentHandKeys = new Set();
    hand.forEach((card, index) => {
      const key = cardKey(card);
      currentHandKeys.add(key);
      const isLegal = canPickThisTurn && legalRanks.has(card.rank);
      const isSelected = selectedRank === card.rank;
      const el = buildCardEl(card.rank, card.suit, isSelected ? "ring-2 ring-cyan-400" : isLegal ? "ring-1 ring-purple-500/50 cursor-pointer" : "opacity-70");
      if (isLegal) {
        el.addEventListener("click", () => {
          selectedRank = selectedRank === card.rank ? null : card.rank;
          selectedSuits = new Set();
          renderTable(lastRoom, lastGame);
        });
      }
      handEl.appendChild(el);
      if (justDealt) {
        dealInAnimate(el, index);
      } else if (previousHandKeys && !previousHandKeys.has(key)) {
        // A card that wasn't in my hand last render: won via a hit, or drawn
        // from the deck on a miss/pass - either way it just "arrived".
        popInAnimate(el);
      }
    });
    previousHandKeys = currentHandKeys;
  }

  // Step 2 of the ask: once a rank is picked, offer all 4 suits of that rank.
  // Suits already in my own hand are shown but disabled/greyed - a single
  // standard deck means an identical card can never exist anywhere else, so
  // picking one of those could never be a hit (see sunduchkiEngine.js's file
  // banner) - this is purely a playability hint, not a server-enforced rule.
  // Multi-select (toggling membership in selectedSuits); the target step
  // below only lights up once at least one suit is chosen, which doubles as
  // this step's "confirm".
  function renderSuitPicker(game) {
    const showPicker = !isSpectating && mySeat === game.activeSeat && selectedRank != null && game.legal && game.legal.canAsk;
    suitPickerEl.hidden = !showPicker;
    suitButtonsEl.textContent = "";
    if (!showPicker) return;
    suitPickerLabelEl.textContent = d.pickSuitPrompt;
    const ownedSuits = new Set(game.you.hand.filter((c) => c.rank === selectedRank).map((c) => c.suit));
    for (const suit of SUIT_ORDER) {
      const owned = ownedSuits.has(suit);
      const isSelected = selectedSuits.has(suit);
      const btn = document.createElement("button");
      btn.type = "button";
      // Each branch owns its own complete text-color utility rather than
      // layering one on top of a base class - two conflicting text-color
      // utilities on one element leave the winner up to compiled stylesheet
      // order, not this string's order (same Tailwind cascade gotcha
      // durak-multiplayer.js's positionAbsolute() documents).
      let colorClass;
      if (owned) colorClass = "border-neutral-800 text-neutral-700 cursor-not-allowed";
      else if (isSelected) colorClass = "border-cyan-400 bg-cyan-500/20 text-cyan-300";
      else colorClass = "border-neutral-700 bg-neutral-800 hover:bg-purple-600 hover:text-white " + (isRed(suit) ? "text-red-500" : "text-neutral-200");
      btn.className = "w-10 h-10 rounded-lg text-lg font-bold border transition-colors " + colorClass;
      btn.textContent = SUIT_SYMBOL[suit];
      btn.disabled = owned;
      btn.title = owned ? d.suitOwnedHint : "";
      if (!owned) {
        btn.addEventListener("click", () => {
          if (selectedSuits.has(suit)) selectedSuits.delete(suit);
          else selectedSuits.add(suit);
          renderTable(lastRoom, lastGame);
        });
      }
      suitButtonsEl.appendChild(btn);
    }
  }

  function renderTargetPicker(game) {
    const showPicker =
      !isSpectating &&
      mySeat === game.activeSeat &&
      selectedRank != null &&
      selectedSuits.size > 0 &&
      game.legal &&
      game.legal.targets.length > 1;
    targetPickerEl.hidden = !showPicker;
    targetButtonsEl.textContent = "";
    if (!showPicker) return;
    targetPickerLabelEl.textContent = d.pickTargetPrompt;
    for (const seat of game.legal.targets) {
      const p = lastRoom.players[seat];
      if (!p) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "px-3 py-1 rounded-lg bg-neutral-800 hover:bg-purple-600 text-neutral-200 hover:text-white text-xs font-medium transition-colors";
      btn.textContent = p.displayName;
      btn.addEventListener("click", () => {
        send({ type: "ask", targetSeat: seat, rank: selectedRank, suits: [...selectedSuits] });
        selectedRank = null;
        selectedSuits = new Set();
      });
      targetButtonsEl.appendChild(btn);
    }
  }

  // Spawns an anchored badge (over the acting seat's own nameplate) for one
  // freshly-arrived public log entry - see spawnLogBadges' caller in
  // renderTable for how "freshly arrived" is determined. Chest completions
  // don't get their own badge here - chestFlourishAnimate (already triggered
  // from renderOpponents/renderHand's own before/after chest-count diff)
  // covers that payoff moment on the chest counter itself.
  function spawnActionBadge(entry) {
    if (entry.pass) {
      showActionBadge(entry.askerSeat, d.badgePassTpl, "bg-neutral-700 text-neutral-200");
    } else if (entry.hit) {
      showActionBadge(
        entry.askerSeat,
        fillTemplate(d.badgeHitTpl, { RANK: rankLabel(entry.rank), COUNT: entry.revealed.length }),
        "bg-emerald-700 text-emerald-50"
      );
    } else {
      showActionBadge(entry.askerSeat, fillTemplate(d.badgeMissTpl, { RANK: rankLabel(entry.rank) }), "bg-rose-900 text-rose-100");
    }
  }

  function renderStatus(room, game) {
    if (!game || !room) return;
    if (game.result) {
      statusEl.textContent = "";
      return;
    }
    if (isSpectating) {
      statusEl.textContent = d.statusWaiting;
      return;
    }
    if (mySeat !== game.activeSeat) {
      statusEl.textContent = d.statusWaiting;
      return;
    }
    statusEl.textContent = game.legal && game.legal.canAsk ? d.statusYourTurnAsk : d.statusYourTurnPass;
  }

  function maybeAutoPass(game) {
    if (isSpectating || mySeat == null) return;
    if (game.phase !== "playing" || game.activeSeat !== mySeat) return;
    if (!game.legal || game.legal.canAsk || !game.legal.canPass) return;
    const signature = game.activeSeat + ":" + (game.you ? game.you.hand.length : 0) + ":" + game.deckCount;
    if (autoPassSignature === signature) return;
    autoPassSignature = signature;
    clearTimeout(autoPassTimer);
    autoPassTimer = setTimeout(() => send({ type: "passEmpty" }), 700);
  }

  function logEntryKey(entry) {
    return JSON.stringify(entry);
  }

  function renderDeck(game) {
    deckEl.textContent = "";
    if (game.deckCount > 0) {
      deckEl.appendChild(buildCardBackEl("w-14 h-20"));
      if (game.deckCount > 1) deckEl.appendChild(buildCardBackEl("w-14 h-20", "-ml-11"));
    }
  }

  function renderTable(room, game, justDealt) {
    if (!game || !room) return;
    lastRoom = room;
    lastGame = game;
    deckCountEl.textContent = String(game.deckCount);
    renderDeck(game);

    // Which log entries are new since the last render, by content rather
    // than array length: game.log is capped to the last 50 entries
    // (sunduchkiEngine.js's serializePublicState), so once a long game hits
    // that cap the array keeps shifting and its length plateaus - comparing
    // lengths alone would silently stop detecting new entries. If the
    // previously-last entry can't be found at all (the cap evicted it, or
    // this is the very first render of a resumed/spectated room), fall back
    // to treating only the current last entry as new rather than replaying
    // a whole backlog of sounds/badges.
    let newEntries = [];
    if (!justDealt && game.log.length) {
      const keys = game.log.map(logEntryKey);
      const idx = previousLastLogKey ? keys.lastIndexOf(previousLastLogKey) : -1;
      newEntries = idx >= 0 ? game.log.slice(idx + 1) : game.log.slice(-1);
    }
    previousLastLogKey = game.log.length ? logEntryKey(game.log[game.log.length - 1]) : null;

    if (justDealt) {
      // Fresh game - nothing rendered so far counts as "newly arrived" (see
      // renderHand/renderOpponents' diff checks below), and the deal itself
      // gets the shuffle sound + staggered deal-in animation instead of the
      // per-move "slide" cue.
      previousHandKeys = null;
      previousChestCounts = null;
      playSound("shuffle");
    } else if (newEntries.length) {
      // This can also fire from a purely local re-render (e.g. selecting a
      // rank), which is why it's gated on actual new entries rather than
      // just "not justDealt".
      playSound("slide");
      for (const entry of newEntries) spawnActionBadge(entry);
    }

    const chestCountsBefore = previousChestCounts;
    renderOpponents(room, game, justDealt, chestCountsBefore);
    renderHand(game, justDealt, chestCountsBefore);
    renderSuitPicker(game);
    renderTargetPicker(game);
    renderStatus(room, game);
    maybeAutoPass(game);
    previousChestCounts = new Map(game.players.map((p) => [p.seat, p.chests.length]));
    myClockEl.title = d.timeRemainingTooltip;
    renderClockDisplays(); // paint immediately - the 250ms interval alone would leave a blank flash
    if (game.result) {
      stopClockTicking();
      showResult(room, game);
    } else {
      resultOverlayEl.hidden = true;
    }
  }

  function showResult(room, game) {
    resultOverlayEl.hidden = false;
    const result = game.result;
    resultDetailEl.textContent = "";
    resultTitleEl.textContent = d.resultTitle;
    if (result.kind === "left-early-win") {
      const winner = room.players[result.winnerSeat];
      const name = result.winnerSeat === mySeat ? d.youLabel : winner ? winner.displayName : "?";
      resultDetailEl.textContent = d.winnerLabel + " " + name;
    }
    renderStandings(room, game);
  }

  // Mirrors realtime/sunduchkiEngine.js's buildPlacements ordering for
  // display purposes only (this client never decides anything authoritative
  // from it) - leaveRank'd seats keep their rank, everyone still active is
  // ranked by chest count with ties sharing a place.
  function computePlacements(room, game) {
    const n = room.players.length;
    const place = new Array(n).fill(null);
    game.players.forEach((p) => {
      if (p.leaveRank != null) place[p.seat] = p.leaveRank;
    });
    if (game.result && game.result.kind === "left-early-win") {
      place[game.result.winnerSeat] = 0;
    } else {
      const activeOrder = game.players
        .filter((p) => place[p.seat] == null)
        .map((p) => ({ seat: p.seat, count: p.chests.length }))
        .sort((a, b) => b.count - a.count);
      activeOrder.forEach((entry, i) => {
        place[entry.seat] = i > 0 && entry.count === activeOrder[i - 1].count ? place[activeOrder[i - 1].seat] : i + 1;
      });
    }
    return place;
  }

  function renderStandings(room, game) {
    resultStandingsEl.textContent = "";
    const nameOf = (seat) => (room.players[seat] ? room.players[seat].displayName : "?");
    const place = computePlacements(room, game); // raw engine-style scale (winner=0, ties share a value) - not display-ready on its own
    const ratingBySeat = new Map((lastRatingChanges || []).map((c) => [c.seat, c.delta]));
    const ordered = game.players.map((p) => p.seat).sort((a, b) => place[a] - place[b]);
    let displayRank = 0;
    ordered.forEach((seat, i) => {
      // Sequential 1-based rank for display, incrementing only when the raw
      // place actually changes - so ties share a number and the numbers
      // shown are always a clean 1,2,3..., regardless of gaps/0-basing in
      // the underlying place[] scale (see computePlacements' own comment).
      if (i === 0 || place[seat] !== place[ordered[i - 1]]) displayRank = i + 1;
      const li = document.createElement("li");
      const chests = game.players[seat].chests.length;
      const delta = ratingBySeat.get(seat);
      const deltaStr = delta != null ? " (" + (delta > 0 ? "+" : "") + delta + ")" : "";
      li.textContent = displayRank + ". " + nameOf(seat) + " — " + chests + deltaStr;
      resultStandingsEl.appendChild(li);
    });
  }

  // Re-render just the hand (not the whole table) whenever the player flips
  // the shared sort-mode toggle mid-game - lastGame is set at the top of
  // every renderTable() call, so it always reflects the latest state.
  if (window.handSortMode) {
    window.handSortMode.onChange(() => {
      if (lastGame && lastGame.you) renderHand(lastGame, false, null);
    });
  }

  // --- Boot --------------------------------------------------------------------

  connect();
  if (embedWatchRoomId) {
    if (stopWatchingBtn) stopWatchingBtn.style.display = "none";
    if (leaveBtn) leaveBtn.style.display = "none";
    if (lobbyViewEl) lobbyViewEl.hidden = true;
    embedWatchdog = setTimeout(() => {
      if (!embedStarted) embedPostEnded();
    }, 8000);
  }
  window.addEventListener("beforeunload", () => {
    deliberateClose = true;
  });
})();
