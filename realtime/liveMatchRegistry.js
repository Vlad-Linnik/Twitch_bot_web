// Cross-game "who's playing right now" registry - the one place that knows
// about in-progress matches across EVERY multiplayer game at once (Durak +
// each quickMatchManager instance), so the spectator hub (/games/watch, via
// realtime/spectatorHubManager.js) can offer a single random-match / auto-
// advance / switch-rooms feed instead of the old per-game-only Watch buttons.
//
// Each game manager registers a source function at startup and calls
// notifyChange() whenever its set of live matches changes (it already does
// this at every room lifecycle transition via broadcastLobby(); the registry
// hook rides along there). This module never touches sockets or game state -
// it's purely a directory. State relaying still flows through each game's own
// per-game WebSocket + watchRoom/spectator plumbing, unchanged.
"use strict";

const EventEmitter = require("events");

// game -> listFn() => [{ roomId, players:[{displayName, connected}], spectatorCount }]
const sources = new Map();
const emitter = new EventEmitter();
// The hub feed and each game manager are all long-lived singletons; the number
// of listeners is tiny and fixed, but silence the default 10-listener warning
// in case several managers/feeds attach.
emitter.setMaxListeners(0);

function registerSource(game, listFn) {
  sources.set(game, listFn);
}

// Called by a manager after its live-match set changes. Coalescing/debouncing
// is the consumer's concern (spectatorHubManager batches a burst of these into
// one broadcast) - here we just fan out the bare signal.
function notifyChange() {
  emitter.emit("change");
}

// A flat list across all games, each entry tagged with its game id so the hub
// knows which page to embed. One misbehaving source can't break the whole
// feed - a throwing listFn is skipped, not propagated.
function listMatches() {
  const out = [];
  for (const [game, listFn] of sources) {
    let list;
    try {
      list = listFn() || [];
    } catch (err) {
      console.error(`[liveMatchRegistry] source "${game}" threw:`, err);
      continue;
    }
    for (const m of list) {
      out.push({ game, roomId: m.roomId, players: m.players, spectatorCount: m.spectatorCount });
    }
  }
  return out;
}

module.exports = { registerSource, notifyChange, listMatches, emitter };
