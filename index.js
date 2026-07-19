const http = require("http");
const env = require("./config/env");
const { connect, connectWeb } = require("./db/connection");
const createApp = require("./app");
const createSessionMiddleware = require("./middleware/session");
const attachSocketServer = require("./realtime/socketServer");
const { startProfileCacheRefreshLoop } = require("./twitch/profileCacheScheduler");
const { startModeratorSyncLoop } = require("./twitch/moderatorSyncScheduler");

async function main() {
  await connect();
  await connectWeb();
  // Built once and shared between the Express app and the WebSocket upgrade
  // handler (realtime/socketServer.js) - see app.js's createApp() comment.
  const sessionMiddleware = createSessionMiddleware();
  const app = createApp(sessionMiddleware);
  const server = http.createServer(app);
  attachSocketServer(server, sessionMiddleware);
  server.listen(env.port, () => {
    console.log(`[TwitchBot-Web] Listening on http://localhost:${env.port}`);
  });
  startProfileCacheRefreshLoop();
  startModeratorSyncLoop();
}

main().catch((err) => {
  console.error("[TwitchBot-Web] Failed to start:", err);
  process.exit(1);
});