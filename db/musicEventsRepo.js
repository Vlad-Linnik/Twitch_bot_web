// Web-only: MusicGraphEvents, the music graph's journal (lib/musicJournal.js says what a row holds). One
// row per background track that ended, and per track a person took out of the feed unheard (`dropped`).
// It carries no logins and no chat text: who pressed "skip" is only "a person", and the chat during a
// track is counts.
//
// On air a row also has category, viewers and hour (of the stream). Added a minute and a half after the
// track ended: asked and chat (db/musicInterestRepo.js).
const { connectWeb } = require("./connection");

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_S = (180 * DAY_MS) / 1000;
const READ_LIMIT = 20000;

let col;

async function ensureInitialized() {
  if (col) return col;
  const events = (await connectWeb()).collection("MusicGraphEvents");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await Promise.all([events.createIndex({ channelId: 1, endedAt: -1 }), events.createIndex({ endedAt: 1 }, { expireAfterSeconds: KEEP_S })]);
  } catch (err) {
    console.error("[musicEventsRepo] createIndex failed:", err.message);
  }
  col = events;
  return col;
}

// Returns the row's id.
async function add(event) {
  const events = await ensureInitialized();
  return (await events.insertOne(event)).insertedId;
}

async function update(id, { set = {}, inc = {} }) {
  const events = await ensureInitialized();
  await events.updateOne({ _id: id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) });
}

// channelId null: every channel's.
async function since(channelId, days, projection = {}) {
  const events = await ensureInitialized();
  return events
    .find({ ...(channelId ? { channelId: String(channelId) } : {}), endedAt: { $gte: new Date(Date.now() - days * DAY_MS) } }, { projection: { title: 0, author: 0, ...projection } })
    .sort({ endedAt: -1 })
    .limit(READ_LIMIT)
    .toArray();
}

module.exports = { add, update, since };
