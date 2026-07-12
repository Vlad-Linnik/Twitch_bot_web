const { MongoClient } = require("mongodb");
const env = require("../config/env");

const client = new MongoClient(env.mongoUri);
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