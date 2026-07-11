const env = require("./config/env");
const { connect } = require("./db/connection");
const createApp = require("./app");

async function main() {
  await connect();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`[TwitchBot-Web] Listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error("[TwitchBot-Web] Failed to start:", err);
  process.exit(1);
});