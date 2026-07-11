const { MongoClient } = require("mongodb");
const env = require("../config/env");

const client = new MongoClient(env.mongoUri);
let db;

async function connect() {
  if (!db) {
    await client.connect();
    db = client.db(env.mongoDb);
    console.log("[db] Connected to MongoDB:", env.mongoDb);
  }
  return db;
}

function getClient() {
  return client;
}

module.exports = { connect, getClient };