const session = require("express-session");
const MongoStore = require("connect-mongo");
const env = require("../config/env");
const { getClient } = require("../db/connection");

function createSessionMiddleware() {
  return session({
    name: "twitchbotweb.sid",
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      client: getClient(),
      dbName: env.mongoDb,
      collectionName: "sessions",
      ttl: 7 * 24 * 60 * 60, // 7 days
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

module.exports = createSessionMiddleware;
