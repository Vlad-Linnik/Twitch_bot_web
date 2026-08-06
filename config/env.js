require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === "production";

// In production these must come from the environment - falling back to the hardcoded
// dev defaults would silently sign sessions/encrypt tokens with a key visible in source.
function requiredInProduction(name, devFallback) {
  return isProduction ? required(name) : process.env[name] || devFallback;
}

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction,

  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  mongoDb: process.env.MONGODB_DB || "twitch_chat_stats",
  // Web-only data the bot never reads (sessions, site preferences, cached Twitch
  // profile data) - kept out of the shared twitch_chat_stats db on purpose, see
  // ../CLAUDE.md's shared-collections table. Same Mongo server, separate database.
  webMongoDb: process.env.WEB_MONGODB_DB || "chatwizardbot_web",

  sessionSecret: requiredInProduction("SESSION_SECRET", "dev_only_insecure_secret"),
  // Encrypts channel owners' persisted Twitch refresh tokens at rest (db/ownerTokensRepo.js,
  // lib/tokenCrypto.js) - deliberately separate from sessionSecret so one leaking doesn't
  // compromise the other.
  tokenEncryptionKey: requiredInProduction("TOKEN_ENCRYPTION_KEY", "dev_only_insecure_token_key"),

  twitchClientId: requiredInProduction("TWITCH_CLIENT_ID", ""),
  twitchClientSecret: requiredInProduction("TWITCH_CLIENT_SECRET", ""),
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI || "http://localhost:3000/auth/callback",

  // The bot's author, credited on /about with their real Twitch chat colour and a link to their
  // channel. A login, not a user ID: the numeric ID is resolved from the Channels collection at
  // request time, so this stays readable and there's one less magic number to keep in sync.
  creatorLogin: (process.env.CREATOR_LOGIN || "vlad_261").toLowerCase(),

  // The bot account's Twitch login, shown in the /request-bot instructions ("type
  // /mod <botLogin> in your chat"). Display-only here - the bot's own credentials
  // live in the bot repo's .env.
  botLogin: (process.env.BOT_LOGIN || "chatwizardbot").toLowerCase(),

  adminUserIds: new Set(
    (process.env.ADMIN_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  ),
};

module.exports = env;
module.exports.required = required;