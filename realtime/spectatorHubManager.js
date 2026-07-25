// The cross-game spectator hub feed - handles /ws/spectator-hub (registered in
// realtime/socketServer.js) for the /games/watch page. It is a DIRECTORY feed
// only: it tells the hub client which matches are live across all games so the
// page can embed one (in an iframe, reusing that game's own bespoke renderer),
// auto-advance when it ends, and list the rest in the switch-rooms panel.
//
// It deliberately relays no game state. Board state still flows through each
// embedded game page's own existing WebSocket + watchRoom/spectator plumbing -
// this manager only pushes {type:"hubMatches", matches:[...]} snapshots,
// sourced from realtime/liveMatchRegistry.js, on connect and whenever the
// live-match set changes.
"use strict";

const liveMatchRegistry = require("./liveMatchRegistry");

// A burst of registry changes (e.g. a room ending evicts spectators, each
// touching broadcastLobby) collapses into a single push a tick later, so a
// hub client isn't hammered with near-identical snapshots.
const DEBOUNCE_MS = 100;

const sockets = new Set();
let debounceTimer = null;

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(payload));
  }
}

function snapshot() {
  return { type: "hubMatches", matches: liveMatchRegistry.listMatches() };
}

function broadcast() {
  if (!sockets.size) return;
  const payload = snapshot();
  for (const ws of sockets) safeSend(ws, payload);
}

function scheduleBroadcast() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    broadcast();
  }, DEBOUNCE_MS);
  debounceTimer.unref();
}

// One subscription for the whole process (this module is a singleton) - every
// hub socket is served from the shared `sockets` set, so we never add/remove
// registry listeners per connection.
liveMatchRegistry.emitter.on("change", scheduleBroadcast);

function handleConnection(ws, _user) {
  sockets.add(ws);
  safeSend(ws, snapshot());
  ws.on("close", () => sockets.delete(ws));
  // The hub client sends nothing (it acts on watch decisions by loading an
  // iframe, not by messaging this socket), but ignore anything it does send
  // rather than letting an unexpected frame throw.
  ws.on("message", () => {});
}

module.exports = { handleConnection };
