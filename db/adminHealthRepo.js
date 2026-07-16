// Collection counters for the admin panel's service-health tiles. Read-only and
// estimatedDocumentCount only (collection metadata, no scan) - `messages`/`ChatWordStats`
// run to millions of rows on a 2GB VPS, an exact count there would be self-inflicted load.
const { connect, connectWeb } = require("./connection");

async function getCollectionCounts() {
  const [db, webDb] = await Promise.all([connect(), connectWeb()]);
  const [messages, chatWordStats, sessions] = await Promise.all([
    db.collection("messages").estimatedDocumentCount(),
    db.collection("ChatWordStats").estimatedDocumentCount(),
    webDb.collection("sessions").estimatedDocumentCount(),
  ]);
  return { messages, chatWordStats, sessions };
}

module.exports = { getCollectionCounts };
