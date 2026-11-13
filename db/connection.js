const { MongoClient } = require("mongodb");
const env = require("../config/env");

// monitorCommands makes the driver emit commandStarted/Succeeded/Failed, which is how
// middleware/requestTiming.js attributes Mongo time to the request that caused it. No listener,
// no work beyond building the event object.
const client = new MongoClient(env.mongoUri, { monitorCommands: true });
let db;
let webDb;

async function connect() {
  if (!db) {
    await client.connect();
    db = client.db(env.mongoDb);
    console.log("[db] Connected to MongoDB:", env.mongoDb);
  }
  return db;
}

// Same MongoClient/connection, second logical database for web-only data
// (sessions, site preferences, cached Twitch profile data) that the bot never
// reads - see ../CLAUDE.md's shared-collections table for why this is separate.
async function connectWeb() {
  if (!webDb) {
    await client.connect();
    webDb = client.db(env.webMongoDb);
    console.log("[db] Connected to MongoDB (web db):", env.webMongoDb);
  }
  return webDb;
}

function getClient() {
  return client;
}

module.exports = { connect, connectWeb, getClient };