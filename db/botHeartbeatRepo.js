// Reads the single BotHeartbeat doc TwitchBot's index.js keeps fresh every ~30s (shared
// twitch_chat_stats db, not the web-only db - see ../CLAUDE.md's shared-collections table).
// Backs the admin panel's bot-status diagnostics tile.
const { connect } = require("./connection");

async function getBotHeartbeat() {
  const db = await connect();
  return db.collection("BotHeartbeat").findOne({ _id: "status" });
}

module.exports = { getBotHeartbeat };
