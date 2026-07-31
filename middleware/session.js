const session = require("express-session");
const MongoStore = require("connect-mongo");
const env = require("../config/env");
const { getClient } = require("../db/connection");

// 30 days, sliding: rolling:true re-issues the cookie (resetting its expiry back to the full
// 30 days) on every response, so a visitor who returns at least once a month never has to log
// in again - previously the cookie's expiry was fixed at login time regardless of activity, so
// even a daily visitor got signed out exactly 7 days after their last login. touchAfter throttles
// how often that same "still active" refresh gets written to the MongoStore-backed sessions
// collection (once/day is plenty of resolution for a 30-day window) so an active user's every
// page view doesn't turn into a DB write.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function createSessionMiddleware() {
  return session({
    name: "twitchbotweb.sid",
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      client: getClient(),
      dbName: env.webMongoDb,
      collectionName: "sessions",
      ttl: SESSION_MAX_AGE_MS / 1000,
      touchAfter: 24 * 60 * 60, // seconds - see comment above
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: SESSION_MAX_AGE_MS,
    },
  });
}

module.exports = createSessionMiddleware;
