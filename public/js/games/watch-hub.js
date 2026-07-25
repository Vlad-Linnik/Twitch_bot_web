// /games/watch - the cross-game spectator hub client. Drives the switch-rooms
// panel and the embedded game iframe off the /ws/spectator-hub directory feed
// (realtime/spectatorHubManager.js). The actual board rendering is NOT here:
// the iframe loads the real game page in ?watch= spectator mode, which reuses
// that game's own bespoke renderer. This file only decides WHICH match the
// iframe shows - pick a random live one on arrival, auto-advance when the
// embedded page reports its match ended (postMessage), and let the viewer
// switch or toggle auto-advance off.
(function () {
  "use strict";

  const root = document.getElementById("watch-root");
  if (!root) return;

  // game id -> the page that renders it in ?watch= spectator mode.
  const GAME_PATHS = {
    "durak-multiplayer": "/games/durak",
    battleship: "/games/battleship",
    pong: "/games/pong",
    "connect-four": "/games/connect-four",
    "sunduchki-multiplayer": "/games/sunduchki",
  };

  const frameWrap = document.getElementById("watch-frame-wrap");
  const frame = document.getElementById("watch-frame");
  const idleEl = document.getElementById("watch-idle");
  const endedNoticeEl = document.getElementById("watch-ended-notice");
  const listEl = document.getElementById("watch-list");
  const listEmptyEl = document.getElementById("watch-list-empty");
  const autoSwitchEl = document.getElementById("watch-auto-switch");

  const gameName = (game) => root.dataset["name" + toCamel(game)] || game;
  const matchVsTpl = root.dataset.matchVsTpl || "{{p1}} vs {{p2}}";
  const spectatorCountTpl = root.dataset.spectatorCountTpl || "{{count}} watching";

  function toCamel(id) {
    // "connect-four" -> "ConnectFour", to match the data-name-* dataset keys
    // (data-name-connect-four becomes dataset.nameConnectFour).
    return id.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  }

  function fillTpl(tpl, vars) {
    return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
  }

  // --- State -----------------------------------------------------------------
  let matches = []; // latest hubMatches list
  let current = null; // { game, roomId } we're actively watching, or null
  // A room we just saw end - don't auto-reload it while it briefly lingers in
  // the feed (the "ended" postMessage can beat the feed update that removes it).
  let endedRoomId = null;
  // Auto-advance off + a match ended => we're holding on the frozen final board
  // waiting for the viewer to pick the next one. Suppresses auto-load until then.
  let awaitingManualPick = false;

  const AUTO_SWITCH_KEY = "watchHubAutoSwitch";
  let autoSwitch = readAutoSwitchPref();
  autoSwitchEl.checked = autoSwitch;

  function readAutoSwitchPref() {
    try {
      const v = localStorage.getItem(AUTO_SWITCH_KEY);
      return v === null ? true : v === "1";
    } catch (_) {
      return true;
    }
  }
  function writeAutoSwitchPref(on) {
    try {
      localStorage.setItem(AUTO_SWITCH_KEY, on ? "1" : "0");
    } catch (_) {
      /* private mode / storage disabled - preference just won't persist */
    }
  }

  // --- Stage (iframe / idle / ended banner) ----------------------------------
  function frameSrcFor(m) {
    const path = GAME_PATHS[m.game];
    if (!path) return null;
    return path + "?watch=" + encodeURIComponent(m.roomId);
  }

  function loadMatch(m) {
    const src = frameSrcFor(m);
    if (!src) return;
    current = { game: m.game, roomId: m.roomId };
    endedRoomId = null;
    awaitingManualPick = false;
    endedNoticeEl.hidden = true;
    idleEl.hidden = true;
    frameWrap.hidden = false;
    frame.src = src;
    renderList();
  }

  function showIdle() {
    current = null;
    awaitingManualPick = false;
    endedNoticeEl.hidden = true;
    frameWrap.hidden = true;
    idleEl.hidden = false;
    if (frame.src && frame.src !== "about:blank") frame.src = "about:blank";
    renderList();
  }

  function pickRandom(excludeRoomId) {
    const pool = matches.filter((m) => m.roomId !== excludeRoomId && GAME_PATHS[m.game]);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // The match we were watching ended (or vanished from the feed).
  function handleCurrentEnded() {
    const ended = current ? current.roomId : endedRoomId;
    endedRoomId = ended;
    if (autoSwitch) {
      const next = pickRandom(ended);
      if (next) loadMatch(next);
      else showIdle(); // nothing else live - wait; a new match auto-loads on arrival
    } else {
      // Keep the frozen final board on screen, just flag it and wait for a pick.
      current = null;
      awaitingManualPick = true;
      endedNoticeEl.hidden = false;
      renderList();
    }
  }

  // --- Panel -----------------------------------------------------------------
  function renderList() {
    listEl.querySelectorAll("[data-watch-row]").forEach((el) => el.remove());
    listEmptyEl.hidden = matches.length > 0;
    for (const m of matches) {
      const li = document.createElement("li");
      li.dataset.watchRow = "1";
      const isCurrent = current && m.roomId === current.roomId;
      li.className =
        "rounded-lg border px-3 py-2.5 cursor-pointer transition-colors " +
        (isCurrent
          ? "border-purple-500/60 bg-purple-500/10"
          : "border-neutral-800 bg-neutral-900 hover:bg-neutral-800");

      const gameLine = document.createElement("p");
      gameLine.className = "text-xs uppercase tracking-wide text-purple-400 mb-0.5";
      gameLine.textContent = gameName(m.game);

      const namesLine = document.createElement("p");
      namesLine.className = "text-sm text-neutral-200 truncate";
      const players = m.players || [];
      const p1 = players[0] ? players[0].displayName + (players[0].connected ? "" : " ✗") : "?";
      const p2 = players[1] ? players[1].displayName + (players[1].connected ? "" : " ✗") : "?";
      // 2 players is the common case (all quick-match games); Durak can seat up
      // to 6, so append the rest plainly after the "P1 vs P2" template.
      let names = fillTpl(matchVsTpl, { p1, p2 });
      if (players.length > 2) names += ", " + players.slice(2).map((p) => p.displayName).join(", ");
      namesLine.textContent = names;

      li.append(gameLine, namesLine);
      if (m.spectatorCount > 0) {
        const countLine = document.createElement("p");
        countLine.className = "text-xs text-neutral-500 mt-0.5";
        countLine.textContent = fillTpl(spectatorCountTpl, { count: m.spectatorCount });
        li.appendChild(countLine);
      }

      li.addEventListener("click", () => loadMatch(m));
      listEl.appendChild(li);
    }
  }

  // --- Feed reconciliation ---------------------------------------------------
  function onMatches(newMatches) {
    matches = Array.isArray(newMatches) ? newMatches.filter((m) => GAME_PATHS[m.game]) : [];
    renderList();

    if (endedRoomId && !matches.some((m) => m.roomId === endedRoomId)) endedRoomId = null;

    if (!matches.length) {
      // Nothing live at all - drop any frozen board and show the waiting panel.
      showIdle();
      return;
    }

    if (current) {
      const stillLive = matches.some((m) => m.roomId === current.roomId);
      if (!stillLive) handleCurrentEnded();
    } else if (!awaitingManualPick) {
      // Not watching and free to pick - jump into a random live match.
      const next = pickRandom(endedRoomId);
      if (next) loadMatch(next);
    }
  }

  // --- Embedded page -> hub ("this match ended") -----------------------------
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.type !== "spectatorMatchEnded") return;
    if (!current || msg.roomId !== current.roomId) return; // stale / not the one we're on
    handleCurrentEnded();
  });

  // --- Auto-switch toggle -----------------------------------------------------
  autoSwitchEl.addEventListener("change", () => {
    autoSwitch = autoSwitchEl.checked;
    writeAutoSwitchPref(autoSwitch);
    // Turned back on while holding on a finished match - resume immediately.
    if (autoSwitch && awaitingManualPick) {
      awaitingManualPick = false;
      endedNoticeEl.hidden = true;
      const next = pickRandom(endedRoomId);
      if (next) loadMatch(next);
      else showIdle();
    }
  });

  // --- WebSocket (directory feed, reconnect w/ backoff) ----------------------
  let ws = null;
  let reconnectAttempt = 0;

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/ws/spectator-hub";
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (msg && msg.type === "hubMatches") onMatches(msg.matches);
    });
    ws.addEventListener("close", () => {
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 15000);
      setTimeout(connect, delay);
    });
    ws.addEventListener("error", () => ws.close());
  }

  connect();
})();
