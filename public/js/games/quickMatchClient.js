// Shared WebSocket connection helper for the auto-matchmaking online games
// (Battleship, Pong, Connect Four). Deliberately the ONE exception
// to this repo's "every on-site game owns its own independent client script"
// convention (see durak-multiplayer.js's header comment) - these games
// share near-identical connect/reconnect/queue/dispatch plumbing, and
// duplicating it per game would just be drift risk. Rendering, input, and
// animation stay 100% bespoke per game (battleship.js, pong.js, etc.) - this
// file only ever touches the WebSocket itself.
//
// Reconnect-with-backoff is copied from durak-multiplayer.js's connect().
(function () {
  "use strict";

  function createQuickMatchClient(wsPath) {
    let ws = null;
    let reconnectAttempt = 0;
    let deliberateClose = false;
    const listeners = new Map(); // message type -> Set<fn>

    function on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => {
        const set = listeners.get(type);
        if (set) set.delete(fn);
      };
    }

    function emit(type, msg) {
      const fns = listeners.get(type);
      if (!fns) return;
      for (const fn of fns) fn(msg);
    }

    function wsUrl() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + location.host + wsPath;
    }

    function send(type, payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(Object.assign({ type }, payload)));
    }

    function connect() {
      deliberateClose = false;
      ws = new WebSocket(wsUrl());

      ws.addEventListener("open", () => {
        reconnectAttempt = 0;
        emit("_open", null);
      });

      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (msg && typeof msg.type === "string") emit(msg.type, msg);
      });

      ws.addEventListener("close", () => {
        emit("_close", null);
        if (deliberateClose) return;
        reconnectAttempt++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 15000);
        setTimeout(connect, delay);
      });
    }

    function disconnect() {
      deliberateClose = true;
      if (ws) ws.close();
    }

    return { connect, send, on, disconnect };
  }

  // Shared "N players searching" + search-time stopwatch wiring (per the
  // feature request) - every one of the 4 games renders it identically, into
  // whichever DOM ids the caller's view uses. Started on "queued"/"queueUpdate"
  // messages relayed by the client above; stopped on "matched" or cancel.
  function wireQueueDisplay(client, els) {
    let queuedAt = null;
    let tickHandle = null;

    function fmtElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return m + ":" + String(s).padStart(2, "0");
    }

    function tick() {
      if (queuedAt == null || !els.timeEl) return;
      els.timeEl.textContent = fmtElapsed(Date.now() - queuedAt);
    }

    function start(queueSize, serverQueuedAt) {
      queuedAt = serverQueuedAt || Date.now();
      if (els.countEl) els.countEl.textContent = String(queueSize);
      tick();
      clearInterval(tickHandle);
      tickHandle = setInterval(tick, 1000);
    }

    function updateCount(queueSize) {
      if (els.countEl) els.countEl.textContent = String(queueSize);
    }

    function stop() {
      queuedAt = null;
      clearInterval(tickHandle);
      tickHandle = null;
    }

    client.on("queued", (msg) => start(msg.queueSize, msg.queuedAt));
    client.on("queueUpdate", (msg) => updateCount(msg.queueSize));
    client.on("matchFound", stop); // a match is found - the ready-check popup takes over
    client.on("matched", stop);

    return { stop };
  }

  // Shared ready-check popup, wired identically for all 4 quick-match games.
  // Once two players are paired the server opens a ready check (mirrors Durak's)
  // - both must click Accept within the countdown or the match is cancelled and
  // an accepting player is auto-re-queued. The popup markup is a shared EJS
  // partial (views/partials/quickMatchReadyCheck.ejs) with fixed ids, so a game
  // client only needs to call this once with its client; no per-view wiring. A
  // notification sound (same one Durak's ready check uses) plays on matchFound.
  const READY_SOUND = new Audio("/sounds/games/quickmatch/notification.wav");
  READY_SOUND.volume = 0.5;

  function playReadySound() {
    try {
      const node = READY_SOUND.cloneNode(true);
      node.volume = READY_SOUND.volume * (window.gameVolume ? window.gameVolume.get() : 1);
      node.play().catch(() => {});
    } catch (_) {
      /* audio unsupported/blocked - the popup still works silently */
    }
  }

  function fillTpl(tpl, vars) {
    return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  }

  function wireReadyCheck(client) {
    const root = document.getElementById("qm-ready-check");
    if (!root) return; // this page didn't include the partial
    const vsEl = document.getElementById("qm-ready-vs");
    const countdownEl = document.getElementById("qm-ready-countdown");
    const countEl = document.getElementById("qm-ready-count");
    const acceptBtn = document.getElementById("qm-ready-accept-btn");
    const waitingEl = document.getElementById("qm-ready-waiting");
    const countdownTpl = root.dataset.countdownTpl || "{{seconds}}";
    const acceptedTpl = root.dataset.acceptedTpl || "{{accepted}}/{{total}}";
    const vsTpl = root.dataset.vsTpl || "{{opponent}}";

    let deadline = null;
    let tickHandle = null;

    function renderCountdown() {
      if (deadline == null) return;
      const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      countdownEl.textContent = fillTpl(countdownTpl, { seconds: secs });
    }

    function stopTicking() {
      if (tickHandle) clearInterval(tickHandle);
      tickHandle = null;
      deadline = null;
    }

    function hide() {
      stopTicking();
      root.hidden = true;
    }

    client.on("matchFound", (msg) => {
      deadline = msg.deadline;
      root.hidden = false;
      const oppName = msg.opponent && msg.opponent.displayName ? msg.opponent.displayName : "";
      vsEl.textContent = oppName ? fillTpl(vsTpl, { opponent: oppName }) : "";
      countEl.textContent = fillTpl(acceptedTpl, { accepted: msg.acceptedCount || 0, total: msg.totalCount || 2 });
      acceptBtn.hidden = false;
      waitingEl.hidden = true;
      renderCountdown();
      if (!tickHandle) tickHandle = setInterval(renderCountdown, 250);
      playReadySound();
    });

    client.on("matchReadyUpdate", (msg) => {
      countEl.textContent = fillTpl(acceptedTpl, { accepted: msg.acceptedCount, total: msg.totalCount });
      if (msg.youAccepted) {
        acceptBtn.hidden = true;
        waitingEl.hidden = false;
      }
    });

    // matched = both accepted (game starting); matchCancelled = it fell through;
    // queued = this player was re-queued after a cancel. All three close it.
    client.on("matched", hide);
    client.on("matchCancelled", hide);
    client.on("queued", hide);

    acceptBtn.addEventListener("click", () => {
      client.send("acceptMatch");
      acceptBtn.hidden = true;
      waitingEl.hidden = false;
      acceptBtn.blur();
    });
  }

  // Shared "who's playing right now" panel (views/partials/quickMatchLobby.ejs),
  // wired identically for all 4 quick-match games - mirrors durak-multiplayer.js's
  // own renderPlayingList, just without room-code/join semantics since these
  // games are FIFO auto-matchmade, never joined by room code. Driven entirely
  // by the server's "lobbyState" broadcast (realtime/quickMatchManager.js),
  // which every connected socket receives while it's neither seated nor
  // spectating - including the idle screen, before the user ever queues.
  function wireQuickMatchLobby(client) {
    const panel = document.getElementById("qm-lobby-panel");
    if (!panel) return; // this page didn't include the partial
    const queueCountEl = document.getElementById("qm-lobby-queue-count");
    const listEl = document.getElementById("qm-lobby-list");
    const listEmptyEl = document.getElementById("qm-lobby-list-empty");
    const watchLabel = panel.dataset.watchLabel || "Watch";
    const matchVsTpl = panel.dataset.matchVsTpl || "{{p1}} vs {{p2}}";
    const spectatorCountTpl = panel.dataset.spectatorCountTpl || "{{count}} watching";

    function renderList(rooms) {
      listEl.querySelectorAll("[data-qm-lobby-row]").forEach((el) => el.remove());
      listEmptyEl.hidden = rooms.length > 0;
      for (const r of rooms) {
        const li = document.createElement("li");
        li.dataset.qmLobbyRow = "1";
        li.className = "flex items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5";

        const info = document.createElement("div");
        const namesLine = document.createElement("p");
        namesLine.className = "text-sm text-neutral-200 truncate max-w-xs";
        const p1 = r.players[0], p2 = r.players[1];
        namesLine.textContent = fillTpl(matchVsTpl, {
          p1: p1.displayName + (p1.connected ? "" : " ✗"),
          p2: p2.displayName + (p2.connected ? "" : " ✗"),
        });
        info.appendChild(namesLine);
        if (r.spectatorCount > 0) {
          const countLine = document.createElement("p");
          countLine.className = "text-xs text-neutral-500";
          countLine.textContent = fillTpl(spectatorCountTpl, { count: r.spectatorCount });
          info.appendChild(countLine);
        }

        const watchBtn = document.createElement("button");
        watchBtn.type = "button";
        watchBtn.className = "px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm font-medium transition-colors shrink-0";
        watchBtn.textContent = watchLabel;
        watchBtn.addEventListener("click", () => client.send("watchRoom", { roomId: r.id }));

        li.append(info, watchBtn);
        listEl.appendChild(li);
      }
    }

    client.on("lobbyState", (msg) => {
      if (queueCountEl) queueCountEl.textContent = String(msg.queueSize);
      renderList(msg.playingRooms || []);
    });
  }

  // Shared spectator-mode bookkeeping, wired identically for all 4 quick-match
  // games. A game's own client script still owns rendering (each game's board
  // is bespoke) - this just tracks the on/off state from the "spectating" flag
  // the server tags onto "state"/"tick" payloads, shows/hides the shared badge
  // + stop-watching button, and detects when a watched match ends (the socket
  // only ever receives "lobbyState" again, via the server's eviction, once it's
  // back in the lobby - see realtime/quickMatchManager.js's evictSpectators).
  function wireQuickMatchSpectating(client, { badgeEl, stopBtn, onExit }) {
    let spectating = false;

    function enter() {
      if (spectating) return;
      spectating = true;
      if (badgeEl) badgeEl.hidden = false;
      if (stopBtn) stopBtn.hidden = false;
    }

    function stop() {
      if (!spectating) return;
      spectating = false;
      if (badgeEl) badgeEl.hidden = true;
      if (stopBtn) stopBtn.hidden = true;
      if (onExit) onExit();
    }

    function onStateLike(msg) {
      if (msg && msg.spectating) enter();
    }

    client.on("state", onStateLike);
    client.on("tick", onStateLike);
    client.on("lobbyState", stop); // no-op unless this socket was spectating
    client.on("matched", stop); // defensive - a spectator never legitimately gets this

    if (stopBtn) {
      stopBtn.addEventListener("click", () => {
        client.send("leaveWatch");
        stop();
        stopBtn.blur();
      });
    }

    return { isSpectating: () => spectating };
  }

  window.createQuickMatchClient = createQuickMatchClient;
  window.wireQuickMatchQueueDisplay = wireQueueDisplay;
  window.wireQuickMatchReadyCheck = wireReadyCheck;
  window.wireQuickMatchLobby = wireQuickMatchLobby;
  window.wireQuickMatchSpectating = wireQuickMatchSpectating;
})();
