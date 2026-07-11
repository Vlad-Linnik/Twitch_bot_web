require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  mongoDb: process.env.MONGODB_DB || "twitch_chat_stats",

  sessionSecret: process.env.SESSION_SECRET || "dev_only_insecure_secret",

  twitchClientId: process.env.TWITCH_CLIENT_ID || "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET || "",
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI || "http://localhost:3000/auth/callback",

  adminUserIds: new Set(
    (process.env.ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  ),
};

module.exports = env;
module.exports.required = required;