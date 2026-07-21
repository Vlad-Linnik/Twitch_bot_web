// WebSocket bootstrap - owns the one WebSocketServer for the whole app and the
// http server's "upgrade" event. Dispatches by URL path to whichever handler
// is registered for it (durakRoomManager for multiplayer Durak, a
// quickMatchManager instance per new online game) - everything downstream
// (rooms, matchmaking, game state) lives in those handler modules, which
// never touch sockets/HTTP directly except through the thin handle this hands
// them (handleConnection(ws, user)).
"use strict";

const { WebSocketServer } = require("ws");
const durakRoomManager = require("./durakRoomManager");
const { createQuickMatchManager } = require("./quickMatchManager");
const battleshipEngine = require("../lib/battleshipEngine");
const pongEngine = require("../lib/pongEngine");
const connectFourEngine = require("../lib/connectFourEngine");
const backgammonEngine = require("../lib/backgammonEngine");

const HEARTBEAT_MS = 30 * 1000;

// path -> { handleConnection(ws, user) }. Every one of the 4 new online games
// is rated (see the implementation plan) - a plain createQuickMatchManager
// call per game, same factory, different engine/mode.
function buildHandlers() {
  const handlers = new Map();
  handlers.set("/ws/durak-multiplayer", durakRoomManager);
  handlers.set(
    "/ws/battleship",
    createQuickMatchManager({ game: "battleship", rated: true, mode: "turn-based", engine: battleshipEngine })
  );
  handlers.set(
    "/ws/pong",
    createQuickMatchManager({ game: "pong", rated: true, mode: "tick", engine: pongEngine, tickMs: 33 })
  );
  handlers.set(
    "/ws/connect-four",
    createQuickMatchManager({ game: "connect-four", rated: true, mode: "turn-based", engine: connectFourEngine })
  );
  handlers.set(
    "/ws/backgammon",
    createQuickMatchManager({ game: "backgammon", rated: true, mode: "turn-based", engine: backgammonEngine })
  );
  return handlers;
}

// A stub `res` for running the upgrade request through the real
// express-session middleware instance (the standard "share the session
// middleware between Express and a raw ws server" trick - see app.js's
// createApp() comment for why it has to be the SAME instance, not just the
// same config). Read-only session checks never touch these, but express-
// session's internals could reasonably call any of them, so they're
// no-ops rather than left undefined.
function makeFakeResponse() {
  return {
    getHeader() {
      return undefined;
    },
    setHeader() {},
    writeHead() {},
    end() {},
  };
}

// A WebSocket handshake isn't subject to the browser's same-origin/CORS
// restrictions the way fetch/XHR are, and the session cookie is
// `sameSite: "lax"` (permits top-level cross-site navigations, which a
// WS handshake counts as) - so without this check, a malicious page on any
// other origin could open an authenticated socket to this site using the
// visitor's own session cookie. This is the WS equivalent of what
// middleware/csrf.js's token already does for form POSTs.
function isSameOriginUpgrade(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (_) {
    return false;
  }
}

function attachSocketServer(httpServer, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });
  const handlers = buildHandlers();

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://placeholder").pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    const handler = handlers.get(pathname);
    if (!handler) {
      socket.destroy();
      return;
    }
    if (!isSameOriginUpgrade(req)) {
      socket.destroy();
      return;
    }

    sessionMiddleware(req, makeFakeResponse(), () => {
      const user = req.session && req.session.user;
      if (!user || !user.userId) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });
        handler.handleConnection(ws, user);
      });
    });
  });

  // Dead sockets (sleep, backgrounding, a yanked network cable) don't always
  // fire a "close" event - without this sweep a stale-but-open socket could
  // hold a room seat forever. unref()'d so it never keeps the process alive.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return wss;
}

module.exports = attachSocketServer;
