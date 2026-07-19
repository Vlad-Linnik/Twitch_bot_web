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
const userProfileService = require("../db/userProfileService");
const { durakRoomCreateLimiter, durakStickerLimiter } = require("../middleware/rateLimiters");

const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 60 * 1000;
const FINISHED_ROOM_CLEANUP_MS = 2 * 60 * 1000;
const READY_CHECK_MS = 45 * 1000;
// How long a beaten table stays visible before engine.finishBeatenPause()
// actually discards it - see durakEngine.js's "beaten-pause" phase. Nobody's
// clock runs during this phase (runningSeats returns []), so this pause
// never eats into either side's time budget.
const BEATEN_PAUSE_MS = 4000;
const GAME_KEY = "durak-multiplayer";
const DEFAULT_RULES = { allowThrowIns: true, allowTransfers: false };
// The fixed sticker set players can react with mid-game (public/js/games/
// durak-multiplayer.js renders the buttons and the pop-in animation; the
// actual images live at public/images/games/durak/stickers/). A closed set
// server-validates msg.stickerId against, same reasoning as isCardShape()
// below - never trust a client-supplied id straight through to a broadcast.
const STICKER_IDS = new Set(["subprise", "bloodtrail", "jokerge"]);

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

function isCardShape(card) {
  return !!card && typeof card === "object" && typeof card.suit === "string" && typeof card.rank === "number";
}

// --- Lobby ---------------------------------------------------------------

// null until at least one seated player has a known rating - loadPlayerProfile
// leaves first-timers' `rating` at null (see its own comment), so an
// all-first-timers room reports "no rating yet" instead of a misleading 0.
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
  // Rooms with a game already underway - shown separately so a visitor can
  // see who's playing right now and, unlike openRooms, watch instead of join
  // (see handleWatchRoom). Deliberately excludes "starting" (ready check,
  // nothing to watch yet) and "finished" (its 2-minute post-game window is
  // for the players' own result screen, not something worth advertising).
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
}

function enterLobby(ws, meta) {
  meta.roomId = null;
  lobbySockets.add(ws);
  sendLobbySnapshot(ws);
}

// Called wherever a room is torn down (rooms.delete) - a spectator has no
// seat to lose and nothing to forfeit, so unlike a player being removed they
// just get dropped straight back into the lobby view rather than left
// pointing at a room that no longer exists.
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
    // Sent on every roomState push regardless of status, so it's visible
    // both in the pre-start lobby (right after creating/joining a room) and
    // throughout the game itself - the same field, never recomputed
    // differently for either phase.
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

function buildClocksPayload(room) {
  // remainingMs is only ever updated at tick time (an action, a leave, or the
  // clock timer firing) - serverNow says exactly when THAT was, so a client
  // can correctly interpolate a live countdown for whichever seats are in
  // runningSeats between snapshots instead of showing a stale, unmoving number.
  return room.clocks
    ? { remainingMs: room.clocks.remainingMs, runningSeats: room.clocks.runningSeats, serverNow: room.clocks.lastTick }
    : null;
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
    // engine.serializeForSeat() path below at all. Nothing to watch yet
    // either (see buildLobbySnapshot), so spectators can't be attached here.
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
    // A player who explicitly left (removeFromRoom's "playing" branch) keeps
    // p.ws valid on purpose - payOutEarlyFinisher still needs it for their
    // one-time early-rating-change notice - but that same socket must NOT
    // keep receiving this game's roomState after the client has already
    // navigated itself back to the lobby, or the next roomState (from a
    // player who stayed still taking turns) yanks them right back into the
    // room view they just left. Same reasoning for spectatingOwnSeat - that
    // socket is now routed through the room.spectators loop below instead.
    if (!p.ws || p.left || p.spectatingOwnSeat) return;
    safeSend(p.ws, { type: "roomState", room: meta, game: engine.serializeForSeat(room.game, seat), clocks });
  });
  if (room.spectators && room.spectators.size) {
    // engine.serializeForSpectator() (unlike serializeForSeat) never includes
    // any seat's actual hand - a spectator sees exactly what's on the table,
    // same as durakEngine.js's file banner promises. The exception is a
    // migrated early finisher (info.ownSeat set, see
    // migrateFinishersToSpectating) - they still get their own
    // serializeForSeat view so the client's early-finish banner (which reads
    // game.you/game.players[seat].finishRank) keeps working unchanged even
    // though "spectating: true" now routes their Leave button through
    // leaveWatch instead of leaveRoom.
    const spectatorPayload = { type: "roomState", room: meta, game: engine.serializeForSpectator(room.game), clocks, spectating: true };
    for (const [ws, info] of room.spectators) {
      if (info.ownSeat != null) {
        safeSend(ws, { type: "roomState", room: meta, game: engine.serializeForSeat(room.game, info.ownSeat), clocks, spectating: true });
      } else {
        safeSend(ws, spectatorPayload);
      }
    }
  }
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
    // Set by migrateFinishersToSpectating() the moment this seat's hand runs
    // out and it locks in a finishRank while the rest of the table is still
    // playing - true for the remainder of this room's life (never reset back
    // to false), so it's a one-way seat->spectator transition, same as left.
    spectatingOwnSeat: false,
    disconnectTimer: null,
    // Filled in asynchronously by loadPlayerProfile() below - null until then,
    // which the client renders as "no avatar / undecorated name / no rating"
    // rather than blocking the join on a Twitch/Mongo round-trip.
    avatarUrl: null,
    color: null,
    rating: null,
  };
}

// Avatar + chat colour (userProfileService, the single "how is this user
// displayed" owner - see its own file header) and current Elo rating
// (gameScoresRepo.getRawRatings, which - unlike getRatings - leaves a player
// with no finished rated game absent from the Map instead of defaulting them
// to durakElo.DEFAULT_RATING, so a first-timer's rating stays hidden here too,
// same policy the leaderboard already follows). Fetched once per join rather
// than on every broadcastRoom() tick, then pushed via one extra room update -
// good enough since none of this changes again until the player's next game
// finishes (ratingChanges handles that separately).
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
    console.error(`[durakRoomManager] failed to load profile for ${entry.userId}:`, err.message);
    return;
  }
  // The room may have been torn down, or this player may have already left,
  // by the time the lookup resolves - only push if they're still there.
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
  // A seat already migrated to spectating (migrateFinishersToSpectating) had
  // its socket routed through room.spectators, not meta.roomId - a refresh
  // closes that old socket (onClose cleans the stale Map entry via
  // meta.watchRoomId) but the player.entry itself, and its spectatingOwnSeat
  // flag, survive the disconnect, so resume the same way instead of
  // dropping them back into a seated player's routing.
  if (entry.spectatingOwnSeat) {
    meta.roomId = null;
    meta.watchRoomId = room.id;
    room.spectators.set(ws, { userId: entry.userId, displayName: entry.displayName, ownSeat: room.players.indexOf(entry) });
  } else {
    meta.roomId = room.id;
  }
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
      evictSpectators(room);
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
    const before = snapshotResolution(room);
    engine.removePlayer(room.game, seat, reason);
    room.players[seat].left = true;
    userActiveRoom.delete(userId);
    syncClock(room); // the active seat set changed - re-tick and reschedule expiry, and may itself forfeit another seat whose clock had already run out
    settleAfter(room, before);
    broadcastRoom(room);
    // A bystander leaving/timing out mid-wave can itself close the wave
    // (checkWaveClosure inside engine.removePlayer) straight into
    // "beaten-pause" - same as any other wave-closing action, that needs its
    // own display-pause timer scheduled, or the table would sit there
    // forever with nothing left to trigger finishBeatenPause().
    if (room.game.phase === "beaten-pause") scheduleBeatenPause(room);
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
    const before = snapshotResolution(room);
    syncClock(room);
    settleAfter(room, before);
    broadcastRoom(room);
    // See removeFromRoom's identical check - a clock-forfeited bystander can
    // close the wave straight into "beaten-pause" too.
    if (room.game.phase === "beaten-pause") scheduleBeatenPause(room);
  }, ms);
  room.clockTimer.unref();
}

// A seat's placement is permanently locked the instant its finishRank OR
// leaveRank is set (buildPlacements keeps either no matter how the rest of
// the game plays out - the one exception, "left-early-win" retroactively
// elevating a lone forced-win survivor above every other seat, including
// ones that had already finished or left for real, is an accepted rare edge
// case rather than something worth threading a retroactive correction for),
// so there's no reason to make that player wait out the rest of the table
// before they see their new rating or start another game - see
// payOutNewlyResolvedSeats' call sites for exactly when either rank can
// newly land.
//
// `place` for every seat that's neither finished nor left yet is set to
// whichever side of this seat's own rank is already certain to hold for that
// pairwise comparison: one worse (finishRank + 1) if THIS seat just finished
// (still-active opponents are guaranteed to end up ranked below a finisher),
// or one better (leaveRank - 1) if THIS seat just left (still-active
// opponents - and even a LATER leaver, who always gets a better leaveRank
// than an earlier one - are guaranteed to end up ranked above a quitter). A
// leaving player earns their placement exactly like a finisher does, just
// counted from the opposite end - not a separate, harsher penalty.
async function payOutEarlyFinisher(room, seat) {
  try {
    const ratings = await room.preGameRatingsPromise;
    const userIds = room.players.map((p) => p.userId);
    const me = room.game.players[seat];
    const isLeaver = me.finishRank == null; // the other branch (finishRank set) takes priority when both could theoretically apply
    const myRank = isLeaver ? me.leaveRank : me.finishRank;
    const entries = room.game.players.map((p, s) => {
      if (s === seat) return { rating: ratings.get(String(userIds[s])), place: myRank };
      if (p.finishRank != null) return { rating: ratings.get(String(userIds[s])), place: p.finishRank };
      if (p.leaveRank != null) return { rating: ratings.get(String(userIds[s])), place: p.leaveRank };
      return { rating: ratings.get(String(userIds[s])), place: isLeaver ? myRank - 1 : myRank + 1 };
    });
    const delta = durakElo.computeSingleEloDelta(entries, seat);
    room.ratingPayouts[seat] = { place: myRank, delta };
    await gameScoresRepo.applyEloDelta(GAME_KEY, userIds[seat], delta, durakElo.DEFAULT_RATING);
    const player = room.players[seat];
    if (player && player.ws) {
      safeSend(player.ws, { type: "ratingChanges", roomId: room.id, early: true, changes: [{ seat, place: myRank, delta }] });
    }
  } catch (err) {
    console.error("[durakRoomManager] failed to pay out an early-resolved seat's rating:", err);
  }
}

// A snapshot of each seat's resolution state, taken right before any engine
// call that might newly resolve one (checkOutPlayers via a bout resolving,
// or removePlayer via a leave/timeout/clock-forfeit) - settleAfter() diffs
// against this afterward to catch whichever seat(s) just got a permanent
// placement.
function snapshotResolution(room) {
  return room.game.players.map((p) => ({ finishRank: p.finishRank, leaveRank: p.leaveRank }));
}

function payOutNewlyResolvedSeats(room, before) {
  const newlyResolved = room.game.players
    .map((p, seat) => seat)
    .filter((seat) => {
      const b = before[seat];
      const p = room.game.players[seat];
      return (b.finishRank == null && p.finishRank != null) || (b.leaveRank == null && p.leaveRank != null);
    });
  for (const seat of newlyResolved) {
    const promise = payOutEarlyFinisher(room, seat).finally(() => room.pendingEarlyPayouts.delete(seat));
    room.pendingEarlyPayouts.set(seat, promise);
  }
}

// Auto-transitions a seat that just ran out of cards and locked in a
// finishRank (NOT a leaveRank - a leave/timeout/disconnect already goes
// through removeFromRoom's "playing" branch, which marks the seat `left`
// itself) from an active player slot into room.spectators. Reuses the
// spectator lifecycle wholesale (broadcastRoom's spectator loop, the
// spectatorCount shown in the lobby, evictSpectators on room teardown,
// handleLeaveWatch's clean removal) instead of leaving a "done but still
// technically seated" player entry that every future broadcastRoom would
// have to remember to skip - that's exactly the class of bug that let a
// player who explicitly left mid-game keep getting yanked back into the
// room (stale room.players entry, still routed a live socket).
function migrateFinishersToSpectating(room, before) {
  room.game.players.forEach((p, seat) => {
    if (before[seat].finishRank != null || p.finishRank == null) return; // not a fresh finish this call
    const entry = room.players[seat];
    if (!entry || entry.left || entry.spectatingOwnSeat || !entry.ws) return;
    entry.spectatingOwnSeat = true;
    room.spectators.set(entry.ws, { userId: entry.userId, displayName: entry.displayName, ownSeat: seat });
    const meta = socketMeta.get(entry.ws);
    if (meta) {
      meta.roomId = null;
      meta.watchRoomId = room.id;
    }
  });
}

// The single post-engine-call routing rule every call site below shares: if
// this call finished the WHOLE game, the final settlement (finalizeGame/
// updateRatings) already knows every seat's real placement, so paying seats
// out individually first would only need undoing - skip straight there.
// Otherwise, pay out whichever seat(s) just newly got a permanent placement,
// then move any seat that finished (not left) into spectating.
function settleAfter(room, before) {
  if (room.game.phase === "finished") {
    finalizeGame(room);
  } else {
    payOutNewlyResolvedSeats(room, before);
    migrateFinishersToSpectating(room, before);
  }
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
    // Any early payout kicked off before this game finished might still be
    // mid-flight (its DB round-trip hasn't resolved yet) - wait for all of
    // them so the ratingPayouts ledger below is fully caught up before
    // deciding who's already been paid.
    if (room.pendingEarlyPayouts && room.pendingEarlyPayouts.size) {
      await Promise.all(room.pendingEarlyPayouts.values());
    }
    const placements = durakElo.buildPlacements(room.game);
    const ratings = await room.preGameRatingsPromise;
    const entries = placements.map(({ seat, place }) => ({ rating: ratings.get(String(userIds[seat])), place }));
    const paidOut = room.ratingPayouts || [];
    const nobodyPaidYet = placements.every(({ seat }) => !paidOut[seat]);

    // The match's very last resolveBout is always what flips the game to
    // "finished" (durakEngine.js's checkOutPlayers/removePlayer), and that
    // always leaves at least one seat (whoever's left active, or the durak)
    // not yet finished at that instant - so at least one seat is guaranteed
    // to still be owed here; "everyone was already paid early" never happens.
    let changes;
    if (nobodyPaidYet) {
      // The common case - nobody left early, so this is the very first (and
      // only) rating computation for the match. Every 2-player game always
      // takes this path: going out with only one opponent left ends the game
      // in the same instant (durakEngine.js's checkOutPlayers), so there's
      // never a still-playing table to pay someone out ahead of. Full
      // simultaneous settlement, same as before this feature existed - every
      // seat's delta comes from ONE computeEloDeltas call, so the whole
      // match's deltas still net to exactly zero.
      const deltas = durakElo.computeEloDeltas(entries);
      changes = placements.map(({ seat, place }, i) => ({ seat, place, delta: deltas[i] }));
    } else {
      // At least one seat already got paid mid-game - its delta is final and
      // can't be revised now that the player may already be off playing
      // somewhere else, so only the seats still owed get computed here, each
      // settled on its own (see computeSingleEloDelta's comment for why this
      // can't reuse computeEloDeltas' batch zero-sum fixup, and
      // payOutEarlyFinisher's comment for the same tradeoff applied earlier).
      changes = placements.map(({ seat, place }) =>
        paidOut[seat] ? { seat, place, delta: paidOut[seat].delta } : { seat, place, delta: durakElo.computeSingleEloDelta(entries, seat) }
      );
    }

    room.ratingChanges = changes;
    await Promise.all(
      changes
        .filter(({ seat }) => !paidOut[seat])
        .map(({ seat, delta }) => gameScoresRepo.applyEloDelta(GAME_KEY, userIds[seat], delta, durakElo.DEFAULT_RATING))
    );
    broadcastRatingChanges(room);
  } catch (err) {
    console.error("[durakRoomManager] failed to update multiplayer Elo ratings:", err);
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
  // One increment per finished room, not per player - callers all gate this
  // behind room.status === "playing" (see resumeIntoRoom's comment above),
  // which is what keeps this from double-counting the same match.
  gameSessionStatsRepo.recordPlay(GAME_KEY).catch((err) => console.error("[durakRoomManager] failed to record play count:", err.message));
  await updateRatings(room);
  const cleanup = setTimeout(() => {
    evictSpectators(room);
    rooms.delete(room.id);
    // Guarded, not a blanket delete: a player who already left this finished
    // room and started/joined another game has userActiveRoom pointing at
    // that new room by now. An unconditional delete here would clobber that
    // live mapping out from under them - on their next reconnect (refresh, a
    // brief network drop) handleConnection() would find nothing and dump
    // them into the lobby instead of resuming the game they're actively in.
    for (const p of room.players) {
      if (userActiveRoom.get(p.userId) === room.id) userActiveRoom.delete(p.userId);
    }
  }, FINISHED_ROOM_CLEANUP_MS);
  cleanup.unref();
  broadcastLobby(); // in case anything was watching room counts elsewhere
}

// --- Message handlers --------------------------------------------------------

function handleCreateRoom(ws, meta) {
  if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
  if (!durakRoomCreateLimiter(meta.userId)) return sendError(ws, "rate-limited");
  const room = {
    id: genRoomId(),
    hostUserId: meta.userId,
    createdAt: Date.now(),
    status: "lobby",
    players: [],
    spectators: new Map(), // ws -> { userId, displayName } - see handleWatchRoom
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

// Host-only, lobby-only (like handleSetRules above) - once a ready check has
// opened there's a dedicated way to drop a seat already (just don't accept,
// see resolveReadyCheckTimeout), and "playing" removal is what leaving/
// disconnecting/the clock already cover. This is purely a pre-game lobby tool
// for a host to clear a seat someone doesn't belong in (AFK, wrong person,
// griefing) before committing to a ready check at all.
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
  // Tell the kicked socket itself before dropping it back into the lobby -
  // removeFromRoom() only updates the room's own state, it has no idea the
  // removal came from someone else's request rather than the player's own
  // leaveRoom. enterLobby() clears meta.roomId and immediately pushes a fresh
  // lobbyState, so "kicked" must go out first or the client would still think
  // it's in the (now nonexistent, for them) room when that snapshot lands.
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
// Read-only: a spectator is never added to room.players and never touches
// engine state, so there's nothing here for durakEngine.js to validate - the
// only enforcement needed is which SERIALIZATION a spectator receives
// (engine.serializeForSpectator, wired into broadcastRoom above), which is
// what actually keeps seated players' hands hidden from them.

function handleWatchRoom(ws, meta, roomId) {
  if (meta.roomId || meta.watchRoomId) return sendError(ws, "already-in-room");
  if (typeof roomId !== "string") return sendError(ws, "bad-request");
  const room = rooms.get(roomId);
  if (!room) return sendError(ws, "room-not-found");
  // Only rooms with a hand actually in progress are watchable - "lobby"/
  // "starting" have no game object yet (see broadcastRoom's early returns),
  // and "finished" is a stray race (the room fell out of buildLobbySnapshot's
  // playingRooms the instant the game ended, so the UI shouldn't be offering
  // a Watch button for it anymore anyway).
  if (room.status !== "playing") return sendError(ws, "room-not-watchable");
  lobbySockets.delete(ws);
  room.spectators.set(ws, { userId: meta.userId, displayName: meta.displayName });
  meta.watchRoomId = room.id;
  broadcastRoom(room); // pushes the initial state to this spectator and the updated spectatorCount to everyone else
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
  // Frozen once, the moment the game starts - every Elo computation for this
  // game (an early payout the instant a seat goes out, and whoever's still
  // active when it truly ends) reads from this same snapshot instead of
  // re-querying mid-game, so one seat's early payout can never change the
  // rating another seat's payout - early or final - computes against. Not
  // awaited here (same fire-and-forget DB round-trip pattern as
  // loadPlayerProfile) - nothing needs it until the first payout, early or
  // final, which is always at least one full action away.
  const userIds = room.players.map((p) => p.userId);
  room.preGameRatingsPromise = gameScoresRepo
    .getRatings(GAME_KEY, userIds, durakElo.DEFAULT_RATING)
    .catch((err) => {
      console.error("[durakRoomManager] failed to snapshot pre-game ratings:", err);
      return new Map(userIds.map((id) => [id, durakElo.DEFAULT_RATING]));
    });
  // Per-seat payout ledger - null until that seat's Elo has actually been
  // applied (either early, mid-game, or as part of the final settlement).
  // updateRatings() consults this so a seat already paid early never gets
  // paid again (or its locked-in delta silently overwritten) once the whole
  // match finally ends.
  room.ratingPayouts = new Array(room.players.length).fill(null);
  // seat -> in-flight payOutEarlyFinisher() promise, for however long its DB
  // round-trip is still outstanding. updateRatings() awaits every entry here
  // before reading ratingPayouts - an early payout is kicked off
  // fire-and-forget, so without this a fast enough final action (someone
  // else immediately finishing the match) could read the ledger before the
  // early payout actually landed and pay that seat a second time.
  room.pendingEarlyPayouts = new Map();
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
    evictSpectators(room);
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
  // Same players-loop exclusions as broadcastRoom(): a player who left keeps
  // p.ws valid (payOutEarlyFinisher needs it) but has no room view left to
  // narrate an action onto - without this check their client falls back to
  // showToast()'s connStatus line, so the game they abandoned keeps
  // narrating itself there indefinitely. A spectatingOwnSeat early finisher
  // gets this same payload through the spectators loop below instead - not
  // filtering them out here would double-deliver it to the same socket.
  for (const p of room.players) {
    if (!p.ws || p.left || p.spectatingOwnSeat) continue;
    safeSend(p.ws, payload);
  }
  if (room.spectators) for (const ws of room.spectators.keys()) safeSend(ws, payload);
}

// Stickers are a pure reaction - unlike broadcastAction() above they never
// come from a game-state change, so they skip handleGameAction() entirely
// (no engine call, no syncClock, no room-state re-broadcast needed).
function broadcastSticker(room, seat, stickerId) {
  const payload = { type: "sticker", seat, stickerId };
  // See broadcastAction() above for why left/spectatingOwnSeat players are
  // excluded from this loop.
  for (const p of room.players) {
    if (!p.ws || p.left || p.spectatingOwnSeat) continue;
    safeSend(p.ws, payload);
  }
  if (room.spectators) for (const ws of room.spectators.keys()) safeSend(ws, payload);
}

function handleSticker(ws, meta, stickerId) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "playing") return sendError(ws, "not-playing");
  const seat = room.players.findIndex((p) => p.userId === meta.userId);
  if (seat < 0) return sendError(ws, "not-in-room");
  if (!durakStickerLimiter(meta.userId)) return sendError(ws, "sticker-rate-limited");
  broadcastSticker(room, seat, stickerId);
}

function handleGameAction(ws, meta, applyFn, msgType) {
  const room = rooms.get(meta.roomId);
  if (!room || room.status !== "playing") return sendError(ws, "not-playing");
  const seat = room.players.findIndex((p) => p.userId === meta.userId);
  if (seat < 0) return sendError(ws, "not-in-room");
  const phaseBefore = room.game.phase;
  const defenderBefore = room.game.defenderSeat;
  const before = snapshotResolution(room);
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
  } else if (phaseBefore !== "beaten-pause" && room.game.phase === "beaten-pause") {
    // A throw-in/defend just closed the wave with everything beaten -
    // defenderBefore (captured before the phase flip) is who beat it off.
    // The table itself doesn't clear yet - see scheduleBeatenPause() below.
    broadcastAction(room, defenderBefore, "beaten");
  }

  syncClock(room); // may itself finish the game via a seat that hit zero mid-action
  settleAfter(room, before);
  broadcastRoom(room);
  if (room.game.phase === "beaten-pause") scheduleBeatenPause(room);
}

// Lets everyone actually see the beaten table for BEATEN_PAUSE_MS before it's
// discarded - runningSeats() returns [] during "beaten-pause" (see
// durakEngine.js), so the syncClock() calls on either side of this timer
// never charge the pause against anyone's clock, attacker or defender alike.
// finishBeatenPause() is a no-op if something else (a player leaving
// mid-pause, via engine.removePlayer) already moved the game past this phase.
function scheduleBeatenPause(room) {
  const timer = setTimeout(() => {
    const before = snapshotResolution(room);
    engine.finishBeatenPause(room.game);
    syncClock(room);
    settleAfter(room, before);
    broadcastRoom(room);
    // See removeFromRoom's identical check - syncClock's clock-forfeit above
    // can itself close the FRESH bout's wave straight into another
    // "beaten-pause" (e.g. the new attacker's clock had also already run out).
    if (room.game.phase === "beaten-pause") scheduleBeatenPause(room);
  }, BEATEN_PAUSE_MS);
  timer.unref();
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
    case "sticker":
      if (typeof msg.stickerId !== "string" || !STICKER_IDS.has(msg.stickerId)) return sendError(ws, "bad-request");
      return handleSticker(ws, meta, msg.stickerId);
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
    const before = snapshotResolution(room);
    syncClock(room); // this disconnect alone doesn't forfeit anyone (that's what disconnectTimer below is for) - but may still surface an unrelated seat's clock having already run out
    settleAfter(room, before);
    broadcastRoom(room);
    // See removeFromRoom's identical check.
    if (room.game.phase === "beaten-pause") scheduleBeatenPause(room);
    entry.disconnectTimer = setTimeout(() => {
      if (entry.connected) return; // reconnected before the timer fired
      removeFromRoom(room, meta.userId, "timeout");
    }, DISCONNECT_GRACE_MS);
    entry.disconnectTimer.unref();
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
