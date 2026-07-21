// Generic auto-matchmaking room manager for the 4 new online-only 1v1 games
// (Battleship, Pong, Connect Four, Backgammon) - createQuickMatchManager(config)
// returns { handleConnection(ws, user) }, the same shape realtime/
// durakRoomManager.js exports, so realtime/socketServer.js's path registry
// can treat every handler uniformly.
//
// Deliberately much lighter than durakRoomManager.js: no lobby/room-code UI,
// no ready-check owned by the room itself (that part IS shared, see below),
// no host privileges, no per-turn chess clock - just FIFO auto-matchmaking
// (queue -> pair the first two waiting players), a room, and a
// disconnect-grace-then-forfeit. Durak's room/lobby machinery isn't reused
// directly (this repo's convention favors a fresh, purpose-built module over
// forcing a new feature through code that already has plenty of
// game-specific branching) - what IS reused verbatim is the session-auth
// story (socketServer.js hands both managers the same `user` shape) and the
// rating math (realtime/durakElo.js, db/gameScoresRepo.js's getRatings/
// applyEloDelta - unchanged, called exactly like durakRoomManager.js's
// updateRatings does for a plain 2-player case).
//
// Spectating (added later) DOES mirror durakRoomManager.js's shape fairly
// closely - lobbySockets/broadcastLobby/enterLobby/evictSpectators are named
// and behave the same way there and here, just scoped per-game (this factory
// runs once per game, so "the lobby" here only ever means "this one game's
// idle/queued viewers"). See handleWatchRoom/handleLeaveWatch below.
"use strict";

const crypto = require("crypto");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const durakElo = require("./durakElo");
const { createSimpleLimiter } = require("../middleware/rateLimiters");

// Queueing is a low-frequency lobby action, same spirit as
// durakRoomCreateLimiter - bounds a misbehaving client spamming "queue"
// without affecting a legitimate player who queues, plays, and queues again.
const QUEUE_WINDOW_MS = 10 * 60 * 1000;
const QUEUE_MAX = 30;

// After two players are paired, both must explicitly Accept within this window
// before the game actually starts (mirrors durakRoomManager.js's ready check -
// catches the player who queued, walked away, and would otherwise be dragged
// into a live rated game). Anyone who accepts but whose match then falls
// through (the other side declined/timed out/disconnected) is auto-re-queued.
const READY_CHECK_MS = 20 * 1000;

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, error) {
  safeSend(ws, { type: "error", error });
}

// config: { game, rated, mode: "turn-based"|"tick", engine, tickMs?, disconnectGraceMs? }
//
// engine interface (see lib/*Engine.js for each game's implementation):
//   createInitialState() -> state
//   serializeForSeat(state, seat) -> plain object safe to send to that seat
//   checkGameOver(state) -> null | { winnerSeat } | { draw: true }
//   turn-based only: applyMove(state, seat, move) -> { ok, error? }
//   tick only:       applyInput(state, seat, input); step(state, dtMs)
function createQuickMatchManager(config) {
  const { game, rated, mode, engine } = config;
  const tickMs = config.tickMs || 33;
  const disconnectGraceMs = config.disconnectGraceMs != null ? config.disconnectGraceMs : mode === "tick" ? 10 * 1000 : 20 * 1000;

  const queueLimiter = createSimpleLimiter({ windowMs: QUEUE_WINDOW_MS, max: QUEUE_MAX });

  const rooms = new Map(); // roomId -> room
  const userActiveRoom = new Map(); // userId -> roomId, only while that room is playing
  const queue = []; // [{ userId, ws, meta, queuedAt }]
  const lobbySockets = new Set(); // sockets on the idle/queued screen - not seated, not spectating

  function genRoomId() {
    let id;
    do {
      id = crypto.randomBytes(4).toString("hex");
    } while (rooms.has(id));
    return id;
  }

  function otherSeat(seat) {
    return seat === 0 ? 1 : 0;
  }

  function broadcastQueueSize() {
    const payload = { type: "queueUpdate", queueSize: queue.length };
    for (const entry of queue) safeSend(entry.ws, payload);
  }

  // --- Lobby (idle-screen queue count + "who's playing now" list) ---------
  // Mirrors durakRoomManager.js's own lobbySockets/buildLobbySnapshot/
  // broadcastLobby/enterLobby/evictSpectators, scoped to this one game.

  function buildLobbySnapshot() {
    const playingRooms = [...rooms.values()]
      .filter((r) => r.status === "playing")
      .map((r) => ({
        id: r.id,
        players: r.players.map((p) => ({ displayName: p.meta.displayName, connected: p.connected })),
        spectatorCount: r.spectators.size,
      }));
    return { type: "lobbyState", queueSize: queue.length, playingRooms };
  }

  function sendLobbySnapshot(ws) {
    safeSend(ws, buildLobbySnapshot());
  }

  function broadcastLobby() {
    const snapshot = buildLobbySnapshot();
    for (const ws of lobbySockets) safeSend(ws, snapshot);
  }

  function enterLobby(ws, meta) {
    meta.roomId = null;
    lobbySockets.add(ws);
    sendLobbySnapshot(ws);
  }

  // A room with spectators is torn down (cleanupRoom) - there's no game left
  // to watch, so every spectator drops straight back into the lobby view,
  // same reasoning as durakRoomManager.js's own evictSpectators.
  function evictSpectators(room) {
    if (!room.spectators.size) return;
    for (const [ws, m] of room.spectators) {
      m.watchRoomId = null;
      enterLobby(ws, m);
    }
    room.spectators.clear();
  }

  // Queue size affects two different audiences: sockets already queued (the
  // existing "queueUpdate" broadcast, unchanged) and idle-screen viewers who
  // haven't queued yet (the new lobbyState broadcast) - without this second
  // half, the idle "N players searching" label could never update itself.
  function queueSizeChanged() {
    broadcastQueueSize();
    broadcastLobby();
  }

  function opponentInfoFor(room, seat) {
    const opp = room.players[otherSeat(seat)];
    return { displayName: opp.meta.displayName, login: opp.meta.login };
  }

  // --- Spectating ------------------------------------------------------------
  // Read-only: a spectator is never added to room.players and never touches
  // engine state. engine.serializeForSpectator (when the engine defines one -
  // only battleshipEngine.js and backgammonEngine.js need to, see their own
  // comments) is what keeps hidden information away from a spectator; engines
  // with nothing to hide (pong, connect four) fall back to serializeForSeat,
  // which for them is already seat-agnostic.
  function spectatorPayloadFor(room) {
    const serialize = engine.serializeForSpectator || ((s) => engine.serializeForSeat(s, 0));
    return {
      state: serialize(room.state),
      spectating: true,
      players: room.players.map((p) => ({ displayName: p.meta.displayName })),
    };
  }

  function broadcastSpectatorState(room, type, deadline) {
    if (!room.spectators.size) return;
    const payload = Object.assign({ type }, spectatorPayloadFor(room));
    if (deadline !== undefined) payload.deadline = deadline;
    for (const ws of room.spectators.keys()) safeSend(ws, payload);
  }

  function handleWatchRoom(ws, meta, roomId) {
    if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
    if (typeof roomId !== "string") return sendError(ws, "bad-request");
    const room = rooms.get(roomId);
    if (!room) return sendError(ws, "room-not-found");
    // Only a room with a game actually in progress is watchable - "readycheck"
    // has no state object worth showing yet, and "finished" is a stray race
    // (the room fell out of buildLobbySnapshot's playingRooms the instant the
    // game ended, so the UI shouldn't be offering a Watch button for it).
    if (room.status !== "playing") return sendError(ws, "room-not-watchable");
    lobbySockets.delete(ws);
    room.spectators.set(ws, meta);
    meta.watchRoomId = room.id;
    safeSend(
      ws,
      Object.assign({ type: mode === "tick" ? "tick" : "state", deadline: deadlinePayload(room) }, spectatorPayloadFor(room))
    );
    broadcastLobby();
  }

  function handleLeaveWatch(ws, meta) {
    const room = meta.watchRoomId ? rooms.get(meta.watchRoomId) : null;
    meta.watchRoomId = null;
    if (room && room.spectators.delete(ws)) broadcastLobby();
    enterLobby(ws, meta);
  }

  function broadcastState(room) {
    const deadline = deadlinePayload(room);
    for (const p of room.players) {
      safeSend(p.ws, { type: "state", state: engine.serializeForSeat(room.state, p.seat), deadline });
    }
    broadcastSpectatorState(room, "state", deadline);
  }

  // --- Phase deadlines (optional engine interface) -------------------------
  // An engine that exposes deadlineTagFor/deadlineMsForTag/onDeadline (only
  // battleshipEngine.js so far - its 1-minute placement and 5-minute battle
  // limits) gets a wall-clock timer per phase, driven from here. The manager
  // owns the clock; the engine only names the current phase's deadline and
  // mutates state when told it elapsed. Tick/other engines lack these hooks,
  // so deadlinePayload stays null and none of this ever runs for them.

  function deadlinePayload(room) {
    return room.deadlineTag ? { tag: room.deadlineTag, at: room.deadlineAt } : null;
  }

  function clearDeadline(room) {
    if (room.deadlineTimer) {
      clearTimeout(room.deadlineTimer);
      room.deadlineTimer = null;
    }
    room.deadlineTag = null;
    room.deadlineAt = null;
  }

  function refreshDeadline(room) {
    if (typeof engine.deadlineTagFor !== "function") return;
    const tag = engine.deadlineTagFor(room.state);
    if (tag === room.deadlineTag) return; // same phase - keep the running timer
    if (room.deadlineTimer) {
      clearTimeout(room.deadlineTimer);
      room.deadlineTimer = null;
    }
    room.deadlineTag = tag;
    if (!tag) {
      room.deadlineAt = null;
      return;
    }
    const ms = engine.deadlineMsForTag(tag);
    room.deadlineAt = Date.now() + ms;
    room.deadlineTimer = setTimeout(() => onDeadlineFired(room), ms);
    room.deadlineTimer.unref();
  }

  function onDeadlineFired(room) {
    if (room.status !== "playing") return;
    room.deadlineTimer = null;
    room.deadlineTag = null; // clear so refreshDeadline re-arms for the new phase
    room.deadlineAt = null;
    const res = engine.onDeadline(room.state) || {};
    refreshDeadline(room);
    broadcastState(room);
    const over = res.gameOver || engine.checkGameOver(room.state);
    if (over) finishGame(room, over.draw ? null : over.winnerSeat, !!over.draw);
  }

  function startTick(room) {
    room.lastTick = Date.now();
    room.tickTimer = setInterval(() => {
      const now = Date.now();
      const dt = now - room.lastTick;
      room.lastTick = now;
      engine.step(room.state, dt);
      for (const p of room.players) {
        safeSend(p.ws, { type: "tick", state: engine.serializeForSeat(room.state, p.seat) });
      }
      broadcastSpectatorState(room, "tick");
      const result = engine.checkGameOver(room.state);
      if (result) finishGame(room, result.draw ? null : result.winnerSeat, !!result.draw);
    }, tickMs);
    room.tickTimer.unref();
  }

  function pauseTick(room) {
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
    }
  }

  function resumeTick(room) {
    if (!room.tickTimer) startTick(room);
  }

  // Pairing no longer starts the game outright - it opens a ready check. The
  // game only begins once both players Accept (beginPlay), or the match is
  // cancelled (cancelReadyCheck) if someone doesn't in time.
  function createRoom(a, b) {
    // Randomized seat assignment - who queued first shouldn't determine who
    // gets Connect Four's first move or Backgammon's opening roll advantage.
    const [p0, p1] = Math.random() < 0.5 ? [a, b] : [b, a];
    const roomId = genRoomId();
    const room = {
      id: roomId,
      status: "readycheck",
      state: engine.createInitialState(),
      tickTimer: null,
      deadlineTimer: null,
      deadlineTag: null,
      deadlineAt: null,
      readyCheck: { deadline: Date.now() + READY_CHECK_MS, accepted: new Set(), timer: null },
      players: [
        { userId: p0.userId, meta: p0.meta, ws: p0.ws, connected: true, seat: 0, disconnectTimer: null },
        { userId: p1.userId, meta: p1.meta, ws: p1.ws, connected: true, seat: 1, disconnectTimer: null },
      ],
      spectators: new Map(), // ws -> meta, see handleWatchRoom
    };
    rooms.set(roomId, room);
    for (const p of room.players) p.meta.roomId = roomId;
    lobbySockets.delete(a.ws);
    lobbySockets.delete(b.ws);
    room.readyCheck.timer = setTimeout(() => resolveReadyCheckTimeout(room), READY_CHECK_MS);
    room.readyCheck.timer.unref();
    for (const p of room.players) {
      safeSend(p.ws, {
        type: "matchFound",
        roomId,
        youAreSeat: p.seat,
        rated: !!rated,
        opponent: opponentInfoFor(room, p.seat),
        deadline: room.readyCheck.deadline,
        acceptedCount: 0,
        totalCount: room.players.length,
      });
    }
    return room;
  }

  function broadcastReadyCheck(room) {
    if (!room.readyCheck) return;
    for (const p of room.players) {
      safeSend(p.ws, {
        type: "matchReadyUpdate",
        acceptedCount: room.readyCheck.accepted.size,
        totalCount: room.players.length,
        youAccepted: room.readyCheck.accepted.has(p.userId),
      });
    }
  }

  function handleAcceptMatch(ws, meta) {
    const room = meta.roomId ? rooms.get(meta.roomId) : null;
    if (!room || room.status !== "readycheck") return;
    const player = findSelf(room, meta);
    if (!player) return;
    room.readyCheck.accepted.add(player.userId);
    if (room.players.every((p) => room.readyCheck.accepted.has(p.userId))) {
      beginPlay(room);
    } else {
      broadcastReadyCheck(room);
    }
  }

  // Both sides accepted - the game genuinely starts here (the work createRoom
  // used to do inline). Rating snapshot + userActiveRoom registration happen
  // now, not at pairing, so a cancelled ready check costs neither.
  function beginPlay(room) {
    if (room.readyCheck && room.readyCheck.timer) clearTimeout(room.readyCheck.timer);
    room.readyCheck = null;
    room.status = "playing";
    for (const p of room.players) userActiveRoom.set(p.userId, room.id);
    if (rated) {
      const userIds = room.players.map((p) => p.userId);
      room.preGameRatingsPromise = gameScoresRepo.getRatings(game, userIds, durakElo.DEFAULT_RATING);
    }
    refreshDeadline(room);
    for (const p of room.players) {
      safeSend(p.ws, {
        type: "matched",
        roomId: room.id,
        youAreSeat: p.seat,
        rated: !!rated,
        opponent: opponentInfoFor(room, p.seat),
        deadline: deadlinePayload(room),
      });
    }
    broadcastState(room);
    if (mode === "tick") startTick(room);
    broadcastLobby(); // room just entered playingRooms
  }

  function resolveReadyCheckTimeout(room) {
    if (!rooms.has(room.id) || room.status !== "readycheck") return;
    cancelReadyCheck(room, null);
  }

  // Tears down a match that never started. Everyone who accepted (and is still
  // connected, and isn't the player who just left) is put back in the queue so
  // they don't have to re-click Find opponent; everyone else drops to idle.
  function cancelReadyCheck(room, excludeUserId) {
    if (room.status !== "readycheck") return;
    if (room.readyCheck.timer) clearTimeout(room.readyCheck.timer);
    const accepted = room.readyCheck.accepted;
    room.status = "cancelled";
    rooms.delete(room.id);
    const requeue = [];
    for (const p of room.players) {
      p.meta.roomId = null;
      if (!p.connected || p.userId === excludeUserId) continue;
      if (accepted.has(p.userId)) requeue.push(p);
      else {
        safeSend(p.ws, { type: "matchCancelled" });
        enterLobby(p.ws, p.meta);
      }
    }
    for (const p of requeue) {
      const entry = { userId: p.userId, ws: p.ws, meta: p.meta, queuedAt: Date.now() };
      queue.push(entry);
      lobbySockets.add(p.ws);
      safeSend(p.ws, { type: "queued", queueSize: queue.length, queuedAt: entry.queuedAt });
    }
    tryMatch();
  }

  function tryMatch() {
    while (queue.length >= 2) createRoom(...queue.splice(0, 2));
    queueSizeChanged();
  }

  function handleQueue(ws, meta) {
    if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
    if (queue.some((e) => e.userId === meta.userId)) return sendError(ws, "already-queued");
    if (!queueLimiter(meta.userId)) return sendError(ws, "rate-limited");
    const entry = { userId: meta.userId, ws, meta, queuedAt: Date.now() };
    queue.push(entry);
    safeSend(ws, { type: "queued", queueSize: queue.length, queuedAt: entry.queuedAt });
    tryMatch();
  }

  function handleCancelQueue(ws, meta) {
    const idx = queue.findIndex((e) => e.userId === meta.userId);
    if (idx < 0) return;
    queue.splice(idx, 1);
    queueSizeChanged();
  }

  function findSelf(room, meta) {
    return room.players.find((p) => p.userId === meta.userId);
  }

  function handleMove(ws, meta, move) {
    if (mode !== "turn-based") return;
    const room = meta.roomId ? rooms.get(meta.roomId) : null;
    if (!room || room.status !== "playing") return sendError(ws, "no-active-game");
    const player = findSelf(room, meta);
    if (!player) return sendError(ws, "not-in-room");
    const result = engine.applyMove(room.state, player.seat, move);
    if (!result || !result.ok) return sendError(ws, (result && result.error) || "invalid-move");
    refreshDeadline(room); // a move may have advanced the phase (placement -> battle)
    broadcastState(room);
    const over = engine.checkGameOver(room.state);
    if (over) finishGame(room, over.draw ? null : over.winnerSeat, !!over.draw);
  }

  function handleInput(ws, meta, input) {
    if (mode !== "tick") return;
    const room = meta.roomId ? rooms.get(meta.roomId) : null;
    if (!room || room.status !== "playing") return;
    const player = findSelf(room, meta);
    if (!player) return;
    engine.applyInput(room.state, player.seat, input);
  }

  function handleResign(ws, meta) {
    const room = meta.roomId ? rooms.get(meta.roomId) : null;
    if (!room || room.status !== "playing") return;
    const player = findSelf(room, meta);
    if (!player) return;
    finishGame(room, otherSeat(player.seat), false);
  }

  async function finishGame(room, winnerSeat, isDraw) {
    if (room.status !== "playing") return;
    room.status = "finished";
    pauseTick(room);
    clearDeadline(room);

    let deltas = null;
    if (rated) {
      try {
        const ratings = await room.preGameRatingsPromise;
        const entries = room.players.map((p) => ({
          rating: ratings.get(String(p.userId)),
          place: isDraw ? 1 : p.seat === winnerSeat ? 1 : 2,
        }));
        deltas = durakElo.computeEloDeltas(entries);
        await Promise.all(
          room.players.map((p, i) => gameScoresRepo.applyEloDelta(game, p.userId, deltas[i], durakElo.DEFAULT_RATING))
        );
      } catch (err) {
        console.error(`[quickMatchManager:${game}] failed to update rating:`, err);
        deltas = null;
      }
    }

    for (let i = 0; i < room.players.length; i++) {
      const payload = { type: "gameOver", result: isDraw ? "draw" : "decided", winnerSeat: isDraw ? null : winnerSeat };
      if (deltas) payload.ratingDelta = deltas[i];
      safeSend(room.players[i].ws, payload);
    }

    try {
      await gameSessionStatsRepo.recordPlay(game);
    } catch (err) {
      console.error(`[quickMatchManager:${game}] failed to record play:`, err);
    }

    cleanupRoom(room);
  }

  function cleanupRoom(room) {
    for (const p of room.players) {
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
      p.meta.roomId = null;
      if (userActiveRoom.get(p.userId) === room.id) userActiveRoom.delete(p.userId);
    }
    rooms.delete(room.id);
    evictSpectators(room);
    for (const p of room.players) {
      if (p.connected && p.ws) enterLobby(p.ws, p.meta);
    }
    broadcastLobby();
  }

  function onMessage(ws, meta, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "queue":
        return handleQueue(ws, meta);
      case "cancelQueue":
        return handleCancelQueue(ws, meta);
      case "acceptMatch":
        return handleAcceptMatch(ws, meta);
      case "move":
        return handleMove(ws, meta, msg.move);
      case "input":
        return handleInput(ws, meta, msg.input);
      case "resign":
        return handleResign(ws, meta);
      case "watchRoom":
        return handleWatchRoom(ws, meta, msg.roomId);
      case "leaveWatch":
        return handleLeaveWatch(ws, meta);
      default:
        return;
    }
  }

  function onClose(ws, meta) {
    lobbySockets.delete(ws);

    const qIdx = queue.findIndex((e) => e.ws === ws);
    if (qIdx >= 0) {
      queue.splice(qIdx, 1);
      queueSizeChanged();
    }

    if (meta.watchRoomId) {
      const watched = rooms.get(meta.watchRoomId);
      meta.watchRoomId = null;
      if (watched && watched.spectators.delete(ws)) broadcastLobby();
    }

    const room = meta.roomId ? rooms.get(meta.roomId) : null;
    if (!room) return;

    // Disconnecting during the ready check cancels the match outright - the
    // other side (if they'd accepted) is auto-re-queued by cancelReadyCheck.
    if (room.status === "readycheck") {
      const self = findSelf(room, meta);
      if (self) {
        self.connected = false;
        self.ws = null;
      }
      cancelReadyCheck(room, meta.userId);
      return;
    }

    if (room.status !== "playing") return;
    const player = findSelf(room, meta);
    if (!player || !player.connected) return;

    player.connected = false;
    player.ws = null;
    const opponent = room.players[otherSeat(player.seat)];
    safeSend(opponent.ws, { type: "opponentDisconnected" });
    if (mode === "tick") pauseTick(room);
    broadcastLobby(); // freshens this room's "connected" badge for spectators/lobby viewers

    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return; // reconnected before the timer fired
      finishGame(room, otherSeat(player.seat), false);
    }, disconnectGraceMs);
    player.disconnectTimer.unref();
  }

  function handleConnection(ws, user) {
    const meta = { userId: String(user.userId), login: user.login, displayName: user.displayName, roomId: null, watchRoomId: null };
    ws.on("message", (raw) => onMessage(ws, meta, raw));
    ws.on("close", () => onClose(ws, meta));

    const existingRoomId = userActiveRoom.get(meta.userId);
    const room = existingRoomId ? rooms.get(existingRoomId) : null;
    if (room && room.status === "playing") {
      const player = findSelf(room, meta);
      if (player) {
        meta.roomId = room.id;
        player.ws = ws;
        player.meta = meta;
        player.connected = true;
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        const opponent = room.players[otherSeat(player.seat)];
        safeSend(opponent.ws, { type: "opponentReconnected" });
        if (mode === "tick") resumeTick(room);
        safeSend(ws, {
          type: "matched",
          roomId: room.id,
          youAreSeat: player.seat,
          rated: !!rated,
          opponent: opponentInfoFor(room, player.seat),
          deadline: deadlinePayload(room),
        });
        safeSend(ws, { type: "state", state: engine.serializeForSeat(room.state, player.seat), deadline: deadlinePayload(room) });
        broadcastLobby();
        return;
      }
    }
    // Otherwise a fresh connection (or a stale userActiveRoom entry with no
    // matching seat) - drop into the lobby view so the idle screen has a live
    // queue count and match list right away, before the client ever sends
    // {type:"queue"}.
    enterLobby(ws, meta);
  }

  return { handleConnection };
}

module.exports = { createQuickMatchManager };
