// All mutable state for multiplayer Durak: the room registry, the public
// lobby, and the WebSocket message dispatcher. realtime/socketServer.js hands
// off every authenticated connection here via handleConnection(ws, user) and
// otherwise never touches game state itself. realtime/durakEngine.js is the
// only place game rules live - this module's job is I/O (sockets, scoring)
// and untrusted-input validation around it, never rules logic.
//
// Rooms are in-memory only (no Mongo) - this deploys as a single Node
// process (no cluster/load-balancer), so that's safe, but it does mean a
// deploy restart drops any in-progress multiplayer games. Accepted trade-off,
// not a bug: persisting full game state and rebuilding client reconnection
// around it would be real added complexity for a rare event.
"use strict";

const crypto = require("crypto");
const engine = require("./durakEngine");
const durakElo = require("./durakElo");
const durakClock = require("./durakClock");
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const { durakRoomCreateLimiter } = require("../middleware/rateLimiters");

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 60 * 1000;
const FINISHED_ROOM_CLEANUP_MS = 2 * 60 * 1000;
const READY_CHECK_MS = 45 * 1000;
const GAME_KEY = "durak-multiplayer";
const DEFAULT_RULES = { allowThrowIns: true, allowTransfers: false };

const rooms = new Map(); // roomId -> Room
const socketMeta = new Map(); // ws -> { userId, login, displayName, roomId }
const userActiveRoom = new Map(); // userId -> roomId, only while that room is lobby/playing
const lobbySockets = new Set(); // sockets currently viewing the lobby (not seated in a room)

function genRoomId() {
  let id;
  do {
    id = crypto.randomBytes(4).toString("hex");
  } while (rooms.has(id));
  return id;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, code) {
  safeSend(ws, { type: "error", code });
}

function isCardShape(card) {
  return !!card && typeof card === "object" && typeof card.suit === "string" && typeof card.rank === "number";
}

// --- Lobby ---------------------------------------------------------------

function buildLobbySnapshot() {
  const openRooms = [...rooms.values()]
    .filter((r) => r.status === "lobby")
    .map((r) => ({
      id: r.id,
      hostDisplayName: r.players.length ? r.players[0].displayName : "?",
      playerCount: r.players.length,
      maxPlayers: MAX_PLAYERS,
    }));
  return { type: "lobbyState", rooms: openRooms };
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

// --- Room state push -------------------------------------------------------

function serializeRoomMeta(room) {
  return {
    id: room.id,
    hostUserId: room.hostUserId,
    status: room.status,
    rules: room.rules,
    players: room.players.map((p) => ({
      userId: p.userId,
      login: p.login,
      displayName: p.displayName,
      connected: p.connected,
      left: p.left,
    })),
  };
}

function broadcastRoom(room) {
  if (room.status === "lobby") {
    const payload = { type: "roomState", room: serializeRoomMeta(room) };
    for (const p of room.players) safeSend(p.ws, payload);
    return;
  }
  if (room.status === "starting") {
    // room.game doesn't exist yet at this point - the ready check is a lobby
    // sub-phase, not gameplay - so this can't go through the generic
    // engine.serializeForSeat() path below at all.
    const meta = serializeRoomMeta(room);
    for (const p of room.players) {
      safeSend(p.ws, {
        type: "roomState",
        room: meta,
        readyCheck: {
          deadline: room.readyCheck.deadline,
          acceptedCount: room.readyCheck.accepted.size,
          totalCount: room.players.length,
          youAccepted: room.readyCheck.accepted.has(p.userId),
        },
      });
    }
    return;
  }
  const meta = serializeRoomMeta(room);
  // remainingMs is only ever updated at tick time (an action, a leave, or the
  // clock timer firing) - serverNow says exactly when THAT was, so a client
  // can correctly interpolate a live countdown for whichever seats are in
  // runningSeats between snapshots instead of showing a stale, unmoving number.
  const clocks = room.clocks
    ? { remainingMs: room.clocks.remainingMs, runningSeats: room.clocks.runningSeats, serverNow: room.clocks.lastTick }
    : null;
  room.players.forEach((p, seat) => {
    if (!p.ws) return;
    safeSend(p.ws, { type: "roomState", room: meta, game: engine.serializeForSeat(room.game, seat), clocks });
  });
}

// --- Room lifecycle ----------------------------------------------------------

function makePlayerEntry(ws, meta) {
  return {
    userId: meta.userId,
    login: meta.login,
    displayName: meta.displayName,
    ws,
    connected: true,
    left: false,
    disconnectTimer: null,
  };
}

function joinRoomInternal(ws, meta, room) {
  lobbySockets.delete(ws);
  room.players.push(makePlayerEntry(ws, meta));
  meta.roomId = room.id;
  userActiveRoom.set(meta.userId, room.id);
  broadcastRoom(room);
}

function resumeIntoRoom(ws, meta, room) {
  const entry = room.players.find((p) => p.userId === meta.userId);
  if (!entry) {
    userActiveRoom.delete(meta.userId);
    enterLobby(ws, meta);
    return;
  }
  lobbySockets.delete(ws);
  if (entry.disconnectTimer) {
    clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = null;
  }
  entry.ws = ws;
  entry.connected = true;
  meta.roomId = room.id;
  // Only while still "playing" - a reconnect into an already-"finished" room
  // (its 2-minute post-game cleanup window) must NOT re-run finalizeGame,
  // which would double-credit that game's Elo changes.
  if (room.status === "playing") {
    syncClock(room); // refreshes remainingMs/lastTick so the resumed snapshot isn't stale
    if (room.game.phase === "finished") finalizeGame(room);
  }
  broadcastRoom(room);
}

function removeFromRoom(room, userId, reason) {
  if (room.status === "lobby" || room.status === "starting") {
    const idx = room.players.findIndex((p) => p.userId === userId);
    if (idx < 0) return;
    const wasStarting = room.status === "starting";
    room.players.splice(idx, 1);
    userActiveRoom.delete(userId);
    if (room.readyCheck) room.readyCheck.accepted.delete(userId);

    if (room.players.length === 0) {
      if (room.readyCheckTimer) {
        clearTimeout(room.readyCheckTimer);
        room.readyCheckTimer = null;
      }
      rooms.delete(room.id);
      broadcastLobby();
      return;
    }
    if (room.hostUserId === userId) room.hostUserId = room.players[0].userId;

    if (wasStarting && room.players.length < 2) {
      // Too few players left to even finish the ready check - cancel it
      // early instead of waiting out the rest of the 45s for nothing.
      if (room.readyCheckTimer) {
        clearTimeout(room.readyCheckTimer);
        room.readyCheckTimer = null;
      }
      room.readyCheck = null;
      room.status = "lobby";
      broadcastRoom(room);
      broadcastLobby();
      return;
    }
    if (wasStarting) {
      // Someone leaving mid-ready-check might have been the last holdout -
      // maybeBeginGame() broadcasts room state itself either way (starts the
      // game, or just reflects the now-smaller total/accepted counts).
      maybeBeginGame(room);
      broadcastLobby();
      return;
    }
    broadcastRoom(room);
    broadcastLobby();
    return;
  }
  if (room.status === "playing") {
    const seat = room.players.findIndex((p) => p.userId === userId);
    if (seat < 0) return;
    engine.removePlayer(room.game, seat, reason);
    room.players[seat].left = true;
    userActiveRoom.delete(userId);
    syncClock(room); // the active seat set changed - re-tick and reschedule expiry
    if (room.game.phase === "finished") {
      finalizeGame(room);
    }
    broadcastRoom(room);
    return;
  }
  userActiveRoom.delete(userId);
}

// --- Per-player time budget ------------------------------------------------
// Each seat gets durakClock.TOTAL_MS_PER_PLAYER (5 minutes) for the whole
// game, chess-clock style: it only drains while durakEngine.js's
// runningSeats(state) says that seat owes an active decision (see that
// function's own comments - single-seat during open/defend, potentially
// several seats at once during a multiplayer wave). Running out forfeits the
// seat exactly like leaving does (engine.removePlayer), which durakElo.js's
// buildPlacements() already scores as tied for the worst placement.

// Re-ticks room.clocks to "now", forfeits anyone who just hit zero, and
// reschedules the single timer that fires at the next seat's expiry if
// nobody acts before then. Called after every state-changing event (a
// player's own action, someone leaving, or the timer firing on its own) so a
// player who simply stops responding is forfeited without requiring anyone
// else to act first.
function syncClock(room) {
  if (!room.clocks || room.status !== "playing") return;
  for (let guard = 0; guard < MAX_PLAYERS + 1; guard++) {
    const now = Date.now();
    const running = room.game.phase === "finished" ? [] : engine.runningSeats(room.game);
    durakClock.tick(room.clocks, now, running);
    if (room.game.phase === "finished") break;
    const expired = durakClock.expiredSeats(room.clocks);
    if (!expired.length) break;
    for (const seat of expired) {
      broadcastAction(room, seat, "timeout");
      engine.removePlayer(room.game, seat, "clock");
      room.players[seat].left = true;
    }
    if (room.game.phase === "finished") break;
    // A forfeited seat can change whose clock should run next (new
    // attacker/defender) - loop once more against the fresh state before
    // settling, rather than scheduling off a stale runningSeats snapshot.
  }
  scheduleClockTimer(room);
}

function scheduleClockTimer(room) {
  if (room.clockTimer) {
    clearTimeout(room.clockTimer);
    room.clockTimer = null;
  }
  if (room.status !== "playing") return;
  const ms = durakClock.msUntilNextExpiry(room.clocks);
  if (ms == null) return;
  room.clockTimer = setTimeout(() => {
    syncClock(room);
    if (room.game.phase === "finished") finalizeGame(room);
    broadcastRoom(room);
  }, ms);
  room.clockTimer.unref();
}

// Every seat gets an Elo update, regardless of result.kind - durakElo's
// buildPlacements() already encodes "first out wins most, the durak loses
// most, simultaneous finishers split evenly" as a finishing-order ranking, so
// there's no more per-kind branching needed here the way the old flat +1
// win-counter required. Runs after every finished game, including "draw",
// unlike the old counter which credited nobody on a draw - a real Elo draw
// still nudges ratings toward the mean, which is the point of using Elo.
async function updateRatings(room) {
  const userIds = room.players.map((p) => p.userId);
  try {
    const placements = durakElo.buildPlacements(room.game);
    const ratings = await gameScoresRepo.getRatings(GAME_KEY, userIds, durakElo.DEFAULT_RATING);
    const entries = placements.map(({ seat, place }) => ({ rating: ratings.get(String(userIds[seat])), place }));
    const deltas = durakElo.computeEloDeltas(entries);
    room.ratingChanges = placements.map(({ seat, place }, i) => ({ seat, place, delta: deltas[i] }));
    await Promise.all(
      room.ratingChanges.map(({ seat, delta }) =>
        gameScoresRepo.applyEloDelta(GAME_KEY, userIds[seat], delta, durakElo.DEFAULT_RATING)
      )
    );
    broadcastRatingChanges(room);
  } catch (err) {
    console.error("[durakRoomManager] failed to update multiplayer Elo ratings:", err);
  }
}

function broadcastRatingChanges(room) {
  if (!room.ratingChanges) return;
  const payload = { type: "ratingChanges", changes: room.ratingChanges };
  for (const p of room.players) safeSend(p.ws, payload);
}

async function finalizeGame(room) {
  room.status = "finished";
  // One increment per finished room, not per player - callers all gate this
  // behind room.status === "playing" (see resumeIntoRoom's comment above),
  // which is what keeps this from double-counting the same match.
  gameSessionStatsRepo.recordPlay(GAME_KEY).catch((err) => console.error("[durakRoomManager] failed to record play count:", err.message));
  await updateRatings(room);
  const cleanup = setTimeout(() => {
    rooms.delete(room.id);
    for (const p of room.players) userActiveRoom.delete(p.userId);
  }, FINISHED_ROOM_CLEANUP_MS);
  cleanup.unref();
  broadcastLobby(); // in case anything was watching room counts elsewhere
}

// --- Message handlers --------------------------------------------------------

function handleCreateRoom(ws, meta) {
  if (meta.roomId) return sendError(ws, "already-in-room");
  if (!durakRoomCreateLimiter(meta.userId)) return sendError(ws, "rate-limited");
  const room = {
    id: genRoomId(),
    hostUserId: meta.userId,
    createdAt: Date.now(),
    status: "lobby",
    players: [],
    game: null,
    rules: { ...DEFAULT_RULES },
  };
  rooms.set(room.id, room);
  joinRoomInternal(ws, meta, room);
  broadcastLobby();
}

function handleSetRules(ws, meta, rules) {
  const room = rooms.get(meta.roomId);
  if (!room) return sendError(ws, "room-not-found");
  if (room.hostUserId !== meta.userId) return sendError(ws, "not-host");
  if (room.status !== "lobby") return sendError(ws, "not-in-lobby");
  if (!rules || typeof rules !== "object") return sendError(ws, "bad-request");
  if (typeof rules.allowThrowIns === "boolean") room.rules.allowThrowIns = rules.allowThrowIns;
  if (typeof rules.allowTransfers === "boolean") room.rules.allowTransfers = rules.allowTransfers;
  broadcastRoom(room);
}

function handleJoinRoom(ws, meta, roomId) {
  if (meta.roomId) return sendError(ws, "already-in-room");
  if (typeof roomId !== "string") return sendError(ws, "bad-request");
  const room = rooms.get(roomId);
  if (!room) return sendError(ws, "room-not-found");
  if (room.status !== "lobby") return sendError(ws, "room-not-joinable");
  if (room.players.length >= MAX_PLAYERS) return sendError(ws, "room-full");
  joinRoomInternal(ws, meta, room);
  broadcastLobby();
}

function handleLeaveRoom(ws, meta) {
  const room = rooms.get(meta.roomId);
  if (room) removeFromRoom(room, meta.userId, "leave");
  enterLobby(ws, meta);
}

// --- Ready check --------------------------------------------------------
// Clicking "Start" doesn't launch the game immediately - it opens a 45s
// window where every seat (host included) must explicitly click Accept. This
// exists specifically to catch the player who's still got the tab open but
// has mentally left the lobby (stepped away, alt-tabbed, forgot they queued
// up) - without it they'd get dragged into a live game, burning their chess
// clock (durakClock.js) doing nothing. Anyone who hasn't accepted by the
// deadline is dropped from the room, same as if they'd left - not "blocked
// from playing", just not present for this attempt.

function handleStartGame(ws, meta) {
  const room = rooms.get(meta.roomId);
  if (!room) return sendError(ws, "room-not-found");
  if (room.hostUserId !== meta.userId) return sendError(ws, "not-host");
  if (room.status !== "lobby") return sendError(ws, "already-started");
  if (room.players.length < 2) return sendError(ws, "not-enough-players");
  room.status = "starting";
  room.readyCheck = { deadline: Date.now() + READY_CHECK_MS, accepted: new Set() };
  room.readyCheckTimer = setTimeout(() => resolveReadyCheckTimeout(room), READY_CHECK_MS);
  room.readyCheckTimer.unref();
  broadcastRoom(room);
  broadcastLobby(); // "starting" rooms drop out of the public lobby list, same as "playing"
}

function handleAcceptStart(ws, meta) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "starting") return sendError(ws, "not-starting");
  const entry = room.players.find((p) => p.userId === meta.userId);
  if (!entry) return sendError(ws, "not-in-room");
  room.readyCheck.accepted.add(meta.userId);
  maybeBeginGame(room);
}

// Called after every change to who's accepted (or who's still in the room)
// while a ready check is open - starts the moment everyone currently seated
// has accepted, rather than always waiting out the full 45s.
function maybeBeginGame(room) {
  if (room.status !== "starting" || room.players.length < 2) return;
  const allAccepted = room.players.every((p) => room.readyCheck.accepted.has(p.userId));
  if (allAccepted) {
    beginGame(room);
  } else {
    broadcastRoom(room);
  }
}

function beginGame(room) {
  if (room.readyCheckTimer) {
    clearTimeout(room.readyCheckTimer);
    room.readyCheckTimer = null;
  }
  room.readyCheck = null;
  room.status = "playing";
  room.game = engine.createGame(room.players.map((p) => p.userId), room.rules);
  room.clocks = durakClock.createClocks(room.players.length);
  syncClock(room);
  broadcastRoom(room);
  broadcastLobby();
}

// Fires exactly once, 45s after handleStartGame() opened the ready check -
// unless the game already began early (maybeBeginGame, once everyone
// accepted) or the room emptied out from under it, either of which leaves
// room.status no longer "starting" by the time this runs, so it's a no-op.
function resolveReadyCheckTimeout(room) {
  if (!room || room.status !== "starting") return;
  room.readyCheckTimer = null;
  const accepted = room.readyCheck.accepted;
  const stragglerIds = new Set(room.players.filter((p) => !accepted.has(p.userId)).map((p) => p.userId));
  room.readyCheck = null;
  if (stragglerIds.size) {
    room.players = room.players.filter((p) => !stragglerIds.has(p.userId));
    for (const userId of stragglerIds) userActiveRoom.delete(userId);
    if (stragglerIds.has(room.hostUserId) && room.players.length) {
      room.hostUserId = room.players[0].userId;
    }
  }
  if (room.players.length === 0) {
    rooms.delete(room.id);
    broadcastLobby();
    return;
  }
  if (room.players.length >= 2) {
    beginGame(room); // broadcasts room + lobby itself
    return;
  }
  room.status = "lobby";
  broadcastRoom(room);
  broadcastLobby();
}

// "open"/"throwIn"/"defend" all leave an obvious trace of their own (a card
// appears on the table), so the client narrates only the two that don't:
// passing (nothing visibly changes at all) and taking (the table clears, but
// so does a clean "beaten" resolution below - from the receiving end alone
// those look identical).
function broadcastAction(room, seat, action) {
  const payload = { type: "action", seat, action };
  for (const p of room.players) safeSend(p.ws, payload);
}

function handleGameAction(ws, meta, applyFn, msgType) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "playing") return sendError(ws, "not-playing");
  const seat = room.players.findIndex((p) => p.userId === meta.userId);
  if (seat < 0) return sendError(ws, "not-in-room");
  const tableLenBefore = room.game.table.length;
  const defenderBefore = room.game.defenderSeat;
  const result = applyFn(room, seat);
  if (!result.ok) return sendError(ws, result.error);

  if (msgType === "passThrowIn") {
    broadcastAction(room, seat, "pass");
  } else if (msgType === "take") {
    broadcastAction(room, seat, "take");
  } else if (msgType === "transfer") {
    // Unlike open/throwIn/defend, a transfer's most important effect - the
    // defend duty jumping to a different seat - isn't obvious just from a new
    // card appearing on the table the way an ordinary throw-in is, so this
    // gets an explicit callout even though it does leave that visible trace.
    broadcastAction(room, seat, "transfer");
  } else if (tableLenBefore > 0 && room.game.table.length === 0) {
    // The table just emptied without anyone taking - a throw-in/defend closed
    // the wave with everything beaten. defenderBefore (captured before
    // resolveBout() reassigns attacker/defender for the next bout) is who just
    // beat it off.
    broadcastAction(room, defenderBefore, "beaten");
  }

  syncClock(room); // may itself finish the game via a seat that hit zero mid-action
  if (room.game.phase === "finished") finalizeGame(room);
  broadcastRoom(room);
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
    case "createRoom":
      return handleCreateRoom(ws, meta);
    case "joinRoom":
      return handleJoinRoom(ws, meta, msg.roomId);
    case "leaveRoom":
      return handleLeaveRoom(ws, meta);
    case "startGame":
      return handleStartGame(ws, meta);
    case "acceptStart":
      return handleAcceptStart(ws, meta);
    case "setRules":
      return handleSetRules(ws, meta, msg.rules);
    case "open":
      if (!isCardShape(msg.card)) return sendError(ws, "bad-request");
      return handleGameAction(ws, meta, (room, seat) => engine.applyOpen(room.game, seat, msg.card), msg.type);
    case "throwIn":
      if (!isCardShape(msg.card)) return sendError(ws, "bad-request");
      return handleGameAction(ws, meta, (room, seat) => engine.applyThrowIn(room.game, seat, msg.card), msg.type);
    case "passThrowIn":
      return handleGameAction(ws, meta, (room, seat) => engine.applyPassThrowIn(room.game, seat), msg.type);
    case "defend":
      if (!isCardShape(msg.card) || !Number.isInteger(msg.tableIndex)) return sendError(ws, "bad-request");
      return handleGameAction(
        ws,
        meta,
        (room, seat) => engine.applyDefend(room.game, seat, msg.tableIndex, msg.card),
        msg.type
      );
    case "transfer":
      if (!isCardShape(msg.card)) return sendError(ws, "bad-request");
      return handleGameAction(ws, meta, (room, seat) => engine.applyTransfer(room.game, seat, msg.card), msg.type);
    case "take":
      return handleGameAction(ws, meta, (room, seat) => engine.applyTake(room.game, seat), msg.type);
    default:
      return;
  }
}

function onClose(ws, meta) {
  socketMeta.delete(ws);
  lobbySockets.delete(ws);
  if (!meta.roomId) return;
  const room = rooms.get(meta.roomId);
  if (!room) return;
  const entry = room.players.find((p) => p.userId === meta.userId);
  if (!entry) return;
  entry.connected = false;
  entry.ws = null;

  if (room.status === "lobby") {
    removeFromRoom(room, meta.userId, "disconnect");
    return;
  }
  if (room.status === "playing") {
    syncClock(room);
    if (room.game.phase === "finished") finalizeGame(room);
    broadcastRoom(room);
    entry.disconnectTimer = setTimeout(() => {
      if (entry.connected) return; // reconnected before the timer fired
      removeFromRoom(room, meta.userId, "timeout");
    }, DISCONNECT_GRACE_MS);
    entry.disconnectTimer.unref();
  }
}

function handleConnection(ws, user) {
  const meta = { userId: String(user.userId), login: user.login, displayName: user.displayName, roomId: null };
  socketMeta.set(ws, meta);
  ws.on("message", (raw) => onMessage(ws, meta, raw));
  ws.on("close", () => onClose(ws, meta));

  const existingRoomId = userActiveRoom.get(meta.userId);
  const existingRoom = existingRoomId ? rooms.get(existingRoomId) : null;
  if (existingRoom) {
    resumeIntoRoom(ws, meta, existingRoom);
  } else {
    enterLobby(ws, meta);
  }
}

module.exports = { handleConnection };
