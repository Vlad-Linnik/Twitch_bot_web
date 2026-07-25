// All mutable state for multiplayer Sunduchki: the room registry, the public
// lobby, and the WebSocket message dispatcher. realtime/socketServer.js hands
// off every authenticated connection here via handleConnection(ws, user) and
// otherwise never touches game state itself. realtime/sunduchkiEngine.js is
// the only place game rules live - this module's job is I/O (sockets,
// scoring) and untrusted-input validation around it, never rules logic.
// Structurally cloned from realtime/durakRoomManager.js (room/lobby/
// ready-check/spectate/Elo plumbing is nearly identical), simplified where
// Sunduchki's rules make Durak's extra machinery unnecessary - see the
// comments below at each point that diverges.
//
// Rooms are in-memory only (no Mongo) - same accepted tradeoff as Durak: a
// deploy restart drops any in-progress game.
"use strict";

const crypto = require("crypto");
const engine = require("./sunduchkiEngine");
const durakElo = require("./durakElo"); // pairwise-round-robin Elo math is fully game-agnostic - see that file's own header
const durakClock = require("./durakClock"); // chess-clock time budget bookkeeping is fully game-agnostic too - see that file's own header
const gameScoresRepo = require("../db/gameScoresRepo");
const gameSessionStatsRepo = require("../db/gameSessionStatsRepo");
const userProfileService = require("../db/userProfileService");
const liveMatchRegistry = require("./liveMatchRegistry");
const { createSimpleLimiter } = require("../middleware/rateLimiters");
const { isValidSpectatorEmote } = require("./spectatorEmotes");

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 60 * 1000;
const FINISHED_ROOM_CLEANUP_MS = 2 * 60 * 1000;
const READY_CHECK_MS = 45 * 1000;
const GAME_KEY = "sunduchki-multiplayer";
const DEFAULT_RULES = { deckSize: "36", questionTarget: "next" };
// Same reasoning/shape as durakRoomCreateLimiter (middleware/rateLimiters.js's
// own header comment asks new games to build their own this way rather than
// adding another named export there per game): room creation is an
// occasional lobby action, not something a legitimate player repeats quickly.
const roomCreateLimiter = createSimpleLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
// Same reasoning/value as durakRoomManager.js's spectatorEmoteLimiter - a
// spectator's skin is a standing choice changed rarely, just bounded so a
// client can't force a broadcastRoom() rebuild on every tick.
const spectatorEmoteLimiter = createSimpleLimiter({ windowMs: 4000, max: 6 });

const rooms = new Map(); // roomId -> Room
const socketMeta = new Map(); // ws -> { userId, login, displayName, roomId, watchRoomId }
const userActiveRoom = new Map(); // userId -> roomId, only while that room is lobby/playing
const lobbySockets = new Set(); // sockets currently viewing the lobby (not seated in a room, not spectating)

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

// --- Lobby ---------------------------------------------------------------

function averageRating(players) {
  const rated = players.map((p) => p.rating).filter((r) => r != null);
  if (!rated.length) return null;
  return Math.round(rated.reduce((sum, r) => sum + r, 0) / rated.length);
}

function buildLobbySnapshot() {
  const openRooms = [...rooms.values()]
    .filter((r) => r.status === "lobby")
    .map((r) => ({
      id: r.id,
      hostDisplayName: r.players.length ? r.players[0].displayName : "?",
      hostRating: r.players.length ? r.players[0].rating : null,
      playerCount: r.players.length,
      maxPlayers: MAX_PLAYERS,
      avgRating: averageRating(r.players),
    }));
  const playingRooms = [...rooms.values()]
    .filter((r) => r.status === "playing")
    .map((r) => ({
      id: r.id,
      players: r.players.map((p) => ({ displayName: p.displayName, left: p.left, rating: p.rating })),
      playerCount: r.players.length,
      spectatorCount: r.spectators.size,
      avgRating: averageRating(r.players),
    }));
  return { type: "lobbyState", rooms: openRooms, playingRooms };
}

function sendLobbySnapshot(ws) {
  safeSend(ws, buildLobbySnapshot());
}

function broadcastLobby() {
  const snapshot = buildLobbySnapshot();
  for (const ws of lobbySockets) safeSend(ws, snapshot);
  liveMatchRegistry.notifyChange();
}

function listLiveMatches() {
  return [...rooms.values()]
    .filter((r) => r.status === "playing")
    .map((r) => ({
      roomId: r.id,
      players: r.players.map((p) => ({ displayName: p.displayName, connected: !p.left && p.connected })),
      spectatorCount: r.spectators.size,
    }));
}
liveMatchRegistry.registerSource(GAME_KEY, listLiveMatches);

function enterLobby(ws, meta) {
  meta.roomId = null;
  lobbySockets.add(ws);
  sendLobbySnapshot(ws);
}

function evictSpectators(room) {
  if (!room.spectators || !room.spectators.size) return;
  for (const ws of room.spectators.keys()) {
    const m = socketMeta.get(ws);
    if (!m) continue;
    m.watchRoomId = null;
    enterLobby(ws, m);
  }
  room.spectators.clear();
}

// --- Room state push -------------------------------------------------------

function serializeRoomMeta(room) {
  return {
    id: room.id,
    hostUserId: room.hostUserId,
    status: room.status,
    rules: room.rules,
    spectatorCount: room.spectators ? room.spectators.size : 0,
    // See durakRoomManager.js's identical field for the full rationale - one
    // entry per current spectator's chosen skin, rendered as that spectator's
    // own pile icon in the shared spectator cluster.
    spectatorEmotes: room.spectators ? [...room.spectators.values()].map((s) => s.emoteId || "default") : [],
    avgRating: averageRating(room.players),
    players: room.players.map((p) => ({
      userId: p.userId,
      login: p.login,
      displayName: p.displayName,
      connected: p.connected,
      left: p.left,
      avatarUrl: p.avatarUrl,
      color: p.color,
      rating: p.rating,
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
  const clocks = buildClocksPayload(room);
  room.players.forEach((p, seat) => {
    if (!p.ws || p.left) return;
    safeSend(p.ws, { type: "roomState", room: meta, game: engine.serializeForSeat(room.game, seat), clocks });
  });
  if (room.spectators && room.spectators.size) {
    const spectatorPayload = {
      type: "roomState",
      room: meta,
      game: engine.serializeForSpectator(room.game),
      clocks,
      spectating: true,
    };
    // yourEmoteId is per-spectator (which button their own picker highlights),
    // so it's spread on top of the otherwise-shared payload object.
    for (const [ws, info] of room.spectators) safeSend(ws, { ...spectatorPayload, yourEmoteId: info.emoteId || "default" });
  }
}

// Same shape/rationale as durakRoomManager.js's buildClocksPayload: sends the
// authoritative snapshot as of the last tick plus serverNow, so a client can
// locally interpolate a live countdown for whichever seat is running between
// snapshots instead of showing a stale, unmoving number.
function buildClocksPayload(room) {
  return room.clocks
    ? { remainingMs: room.clocks.remainingMs, runningSeats: room.clocks.runningSeats, serverNow: room.clocks.lastTick }
    : null;
}

// A lightweight event for narrating why a seat just vanished (timeout,
// disconnect, explicit leave, kick) - the engine's own public log (part of
// every roomState) already narrates every ask/pass, but removePlayer itself
// doesn't log an entry, so without this the table would just see a seat's
// hand count disappear with no explanation.
function broadcastPlayerLeft(room, seat, reason) {
  const payload = { type: "playerLeft", seat, reason };
  for (const p of room.players) {
    if (!p.ws || p.left) continue;
    safeSend(p.ws, payload);
  }
  if (room.spectators) for (const ws of room.spectators.keys()) safeSend(ws, payload);
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
    avatarUrl: null,
    color: null,
    rating: null,
  };
}

async function loadPlayerProfile(room, entry) {
  try {
    const [profile, ratings] = await Promise.all([
      userProfileService.getDisplayProfile(entry.userId),
      gameScoresRepo.getRawRatings(GAME_KEY, [entry.userId]),
    ]);
    entry.avatarUrl = profile.avatarUrl;
    entry.color = profile.color;
    entry.rating = ratings.has(entry.userId) ? ratings.get(entry.userId) : null;
  } catch (err) {
    console.error(`[sunduchkiRoomManager] failed to load profile for ${entry.userId}:`, err.message);
    return;
  }
  if (rooms.get(room.id) === room && room.players.includes(entry)) {
    broadcastRoom(room);
  }
}

function joinRoomInternal(ws, meta, room) {
  lobbySockets.delete(ws);
  const entry = makePlayerEntry(ws, meta);
  room.players.push(entry);
  meta.roomId = room.id;
  userActiveRoom.set(meta.userId, room.id);
  broadcastRoom(room);
  loadPlayerProfile(room, entry);
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
      evictSpectators(room);
      rooms.delete(room.id);
      broadcastLobby();
      return;
    }
    if (room.hostUserId === userId) room.hostUserId = room.players[0].userId;

    if (wasStarting && room.players.length < 2) {
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
    broadcastPlayerLeft(room, seat, reason);
    syncClock(room); // the active seat, and so whose clock runs, may have just changed
    broadcastRoom(room);
    if (room.game.phase === "finished") {
      finalizeGame(room);
    }
    return;
  }
  userActiveRoom.delete(userId);
}

// --- Per-player time budget (chess-clock style) -----------------------------
// Each seat gets durakClock.TOTAL_MS_PER_PLAYER (5 minutes) for the whole
// game, ported wholesale from durakRoomManager.js's own syncClock/
// scheduleClockTimer: durakClock.js is pure and game-agnostic (see its own
// header), it only needs to be told which seats are currently "running" -
// engine.runningSeats(state) here is just [activeSeat] while playing, since
// Sunduchki (unlike Durak) never has more than one seat owing a decision at
// once. userActiveRoom is deliberately left pointing at this room when a seat
// times out so a later reconnect still finds it (and, once the game
// finishes, the ratingChanges notice - see finalizeGame) - only cleaned up by
// finalizeGame's own cleanup sweep.
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
      engine.removePlayer(room.game, seat, "clock");
      if (room.players[seat]) room.players[seat].left = true;
      broadcastPlayerLeft(room, seat, "clock");
    }
    // A forfeited seat can change whose clock should run next - loop once
    // more against the fresh state before scheduling, rather than scheduling
    // off a stale runningSeats snapshot.
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
    broadcastRoom(room);
    if (room.game.phase === "finished") finalizeGame(room);
  }, ms);
  room.clockTimer.unref();
}

// --- Scoring -----------------------------------------------------------------
// Unlike Durak, nobody in Sunduchki ever finishes individually mid-game - the
// whole game ends for everyone at once (every rank chested, a stalemate, or
// a lone forced-win survivor - see sunduchkiEngine.js's checkGameEnd/
// removePlayer) - so there's no early-finisher payout path to mirror from
// durakRoomManager.js; every seat is always settled together, in one
// computeEloDeltas call, exactly once per finished room.

async function updateRatings(room) {
  const userIds = room.players.map((p) => p.userId);
  try {
    const placements = engine.buildPlacements(room.game);
    const ratings = await room.preGameRatingsPromise;
    const entries = placements.map(({ seat, place }) => ({ rating: ratings.get(String(userIds[seat])), place }));
    const deltas = durakElo.computeEloDeltas(entries);
    const changes = placements.map(({ seat, place }, i) => ({ seat, place, delta: deltas[i] }));
    room.ratingChanges = changes;
    await Promise.all(changes.map(({ seat, delta }) => gameScoresRepo.applyEloDelta(GAME_KEY, userIds[seat], delta, durakElo.DEFAULT_RATING)));
    broadcastRatingChanges(room);
  } catch (err) {
    console.error("[sunduchkiRoomManager] failed to update multiplayer Elo ratings:", err);
  }
}

function broadcastRatingChanges(room) {
  if (!room.ratingChanges) return;
  const payload = { type: "ratingChanges", roomId: room.id, changes: room.ratingChanges };
  for (const p of room.players) safeSend(p.ws, payload);
  if (room.spectators) for (const ws of room.spectators.keys()) safeSend(ws, payload);
}

async function finalizeGame(room) {
  room.status = "finished";
  gameSessionStatsRepo.recordPlay(GAME_KEY).catch((err) => console.error("[sunduchkiRoomManager] failed to record play count:", err.message));
  await updateRatings(room);
  const cleanup = setTimeout(() => {
    evictSpectators(room);
    rooms.delete(room.id);
    for (const p of room.players) {
      if (userActiveRoom.get(p.userId) === room.id) userActiveRoom.delete(p.userId);
    }
  }, FINISHED_ROOM_CLEANUP_MS);
  cleanup.unref();
  broadcastLobby();
}

// --- Message handlers --------------------------------------------------------

function handleCreateRoom(ws, meta) {
  if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
  if (!roomCreateLimiter(meta.userId)) return sendError(ws, "rate-limited");
  const room = {
    id: genRoomId(),
    hostUserId: meta.userId,
    createdAt: Date.now(),
    status: "lobby",
    players: [],
    spectators: new Map(),
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
  if (rules.deckSize === "36" || rules.deckSize === "52") room.rules.deckSize = rules.deckSize;
  if (rules.questionTarget === "next" || rules.questionTarget === "any") room.rules.questionTarget = rules.questionTarget;
  broadcastRoom(room);
}

function handleKickPlayer(ws, meta, targetUserId) {
  const room = rooms.get(meta.roomId);
  if (!room) return sendError(ws, "room-not-found");
  if (room.hostUserId !== meta.userId) return sendError(ws, "not-host");
  if (room.status !== "lobby") return sendError(ws, "not-in-lobby");
  if (typeof targetUserId !== "string" || targetUserId === meta.userId) return sendError(ws, "bad-request");
  const target = room.players.find((p) => p.userId === targetUserId);
  if (!target) return sendError(ws, "player-not-found");
  const targetWs = target.ws;
  const targetMeta = targetWs ? socketMeta.get(targetWs) : null;
  removeFromRoom(room, targetUserId, "kicked");
  if (targetWs && targetMeta) {
    safeSend(targetWs, { type: "kicked" });
    enterLobby(targetWs, targetMeta);
  }
}

function handleJoinRoom(ws, meta, roomId) {
  if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
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

// --- Spectating ------------------------------------------------------------

function handleWatchRoom(ws, meta, roomId) {
  if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
  if (typeof roomId !== "string") return sendError(ws, "bad-request");
  const room = rooms.get(roomId);
  if (!room) return sendError(ws, "room-not-found");
  if (room.status !== "playing") return sendError(ws, "room-not-watchable");
  lobbySockets.delete(ws);
  room.spectators.set(ws, { userId: meta.userId, displayName: meta.displayName, emoteId: "default" });
  meta.watchRoomId = room.id;
  broadcastRoom(room);
  broadcastLobby();
}

function handleLeaveWatch(ws, meta) {
  const room = rooms.get(meta.watchRoomId);
  meta.watchRoomId = null;
  if (room && room.spectators.delete(ws)) {
    broadcastRoom(room);
    broadcastLobby();
  }
  enterLobby(ws, meta);
}

// Same reasoning as durakRoomManager.js's identical handler: a standing
// per-spectator property, not a fleeting reaction, so the only broadcast
// needed is the next full roomState.
function handleSetSpectatorEmote(ws, meta, emoteId) {
  const room = rooms.get(meta.watchRoomId);
  if (!room) return sendError(ws, "not-watching");
  const info = room.spectators.get(ws);
  if (!info) return sendError(ws, "not-watching");
  if (!spectatorEmoteLimiter(meta.userId)) return sendError(ws, "spectator-emote-rate-limited");
  info.emoteId = emoteId;
  broadcastRoom(room);
}

// --- Ready check --------------------------------------------------------

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
  broadcastLobby();
}

function handleAcceptStart(ws, meta) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "starting") return sendError(ws, "not-starting");
  const entry = room.players.find((p) => p.userId === meta.userId);
  if (!entry) return sendError(ws, "not-in-room");
  room.readyCheck.accepted.add(meta.userId);
  maybeBeginGame(room);
}

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
  // Freeze the resolved rules (deckSize as the concrete number actually
  // dealt) so serializeRoomMeta's rules, shown for "playing" rooms too,
  // always reflects what's really in play.
  room.rules = { deckSize: room.game.rules.deckSize, questionTarget: room.game.rules.questionTarget };
  const userIds = room.players.map((p) => p.userId);
  room.preGameRatingsPromise = gameScoresRepo
    .getRatings(GAME_KEY, userIds, durakElo.DEFAULT_RATING)
    .catch((err) => {
      console.error("[sunduchkiRoomManager] failed to snapshot pre-game ratings:", err);
      return new Map(userIds.map((id) => [id, durakElo.DEFAULT_RATING]));
    });
  room.clocks = durakClock.createClocks(room.players.length);
  syncClock(room);
  broadcastRoom(room);
  broadcastLobby();
}

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
    evictSpectators(room);
    rooms.delete(room.id);
    broadcastLobby();
    return;
  }
  if (room.players.length >= 2) {
    beginGame(room);
    return;
  }
  room.status = "lobby";
  broadcastRoom(room);
  broadcastLobby();
}

// --- Gameplay ----------------------------------------------------------------

// syncClock runs BEFORE broadcastRoom (not after) so the roomState clients
// receive already carries the freshly-recomputed clock snapshot instead of a
// stale pre-action one - this ordering is exactly what the old flat per-turn
// timer got backwards.
function afterGameAction(room) {
  syncClock(room);
  broadcastRoom(room);
  if (room.game.phase === "finished") {
    finalizeGame(room);
  }
}

function handleAsk(ws, meta, targetSeat, rank, suits) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "playing") return sendError(ws, "not-playing");
  const seat = room.players.findIndex((p) => p.userId === meta.userId);
  if (seat < 0) return sendError(ws, "not-in-room");
  if (!Number.isInteger(targetSeat) || !Number.isInteger(rank) || !Array.isArray(suits)) return sendError(ws, "bad-request");
  const result = engine.applyAsk(room.game, seat, targetSeat, rank, suits);
  if (!result.ok) return sendError(ws, result.error);
  afterGameAction(room);
}

function handlePassEmpty(ws, meta) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "playing") return sendError(ws, "not-playing");
  const seat = room.players.findIndex((p) => p.userId === meta.userId);
  if (seat < 0) return sendError(ws, "not-in-room");
  const result = engine.applyPassEmpty(room.game, seat);
  if (!result.ok) return sendError(ws, result.error);
  afterGameAction(room);
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
    case "watchRoom":
      return handleWatchRoom(ws, meta, msg.roomId);
    case "leaveWatch":
      return handleLeaveWatch(ws, meta);
    case "startGame":
      return handleStartGame(ws, meta);
    case "acceptStart":
      return handleAcceptStart(ws, meta);
    case "setRules":
      return handleSetRules(ws, meta, msg.rules);
    case "kickPlayer":
      return handleKickPlayer(ws, meta, msg.userId);
    case "ask":
      return handleAsk(ws, meta, msg.targetSeat, msg.rank, msg.suits);
    case "passEmpty":
      return handlePassEmpty(ws, meta);
    case "setSpectatorEmote":
      if (!isValidSpectatorEmote(msg.emoteId)) return sendError(ws, "bad-request");
      return handleSetSpectatorEmote(ws, meta, msg.emoteId);
    default:
      return;
  }
}

function onClose(ws, meta) {
  socketMeta.delete(ws);
  lobbySockets.delete(ws);
  if (meta.watchRoomId) {
    const watchedRoom = rooms.get(meta.watchRoomId);
    if (watchedRoom && watchedRoom.spectators.delete(ws)) {
      broadcastRoom(watchedRoom);
      broadcastLobby();
    }
  }
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
    entry.disconnectTimer = setTimeout(() => {
      if (entry.connected) return; // reconnected before the timer fired
      removeFromRoom(room, meta.userId, "timeout");
    }, DISCONNECT_GRACE_MS);
    entry.disconnectTimer.unref();
    // This disconnect alone doesn't forfeit anyone (that's what
    // disconnectTimer above is for) - but re-ticking now still surfaces an
    // unrelated seat's clock having already run out, same as
    // durakRoomManager.js's own onClose handling.
    syncClock(room);
    broadcastRoom(room);
  }
}

function handleConnection(ws, user) {
  const meta = { userId: String(user.userId), login: user.login, displayName: user.displayName, roomId: null, watchRoomId: null };
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
