const env = require("./config/env");
const { connect, connectWeb } = require("./db/connection");
const createApp = require("./app");
const { startProfileCacheRefreshLoop } = require("./twitch/profileCacheScheduler");
const { startModeratorSyncLoop } = require("./twitch/moderatorSyncScheduler");

async function main() {
  await connect();
  await connectWeb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[TwitchBot-Web] Listening on http://localhost:${env.port}`);
  });
  startProfileCacheRefreshLoop();
  startModeratorSyncLoop();
}

main().catch((err) => {
  console.error("[TwitchBot-Web] Failed to start:", err);
  process.exit(1);
});