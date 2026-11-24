// The viewers' interest graph's storage (lib/musicInterest.js).
//
// Web-only: MusicGraphInterest, one row per channel, viewer and song asked about:
//   { channelId, userId, id, videoId, title, author, n (how many playings it was asked about),
//     donation (true: it last played as a paid clip), firstAt, lastAt (TTL 180 days) }
// `id` is lib/musicGraph.js songId(). The viewer is a numeric Twitch id and only there to tell viewers
// apart: no name is kept, and no page shows one.
//
// Read from the shared db, bot-owned and never written here: `messages` (by channel and time) and the
// channel's emote words in `whiteList`.
const { connect, connectWeb } = require("./connection");
const { createCache } = require("../lib/queryCache");

const KEEP_S = 180 * 24 * 60 * 60;
const MESSAGES_MAX = 5000;
const ROWS_MAX = 20000;

let col;

async function ensureInitialized() {
  if (col) return col;
  const interest = (await connectWeb()).collection("MusicGraphInterest");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await Promise.all([
      interest.createIndex({ channelId: 1, userId: 1, id: 1 }, { unique: true }),
      interest.createIndex({ channelId: 1, lastAt: -1 }),
      interest.createIndex({ lastAt: 1 }, { expireAfterSeconds: KEEP_S }),
    ]);
  } catch (err) {
    console.error("[musicInterestRepo] createIndex failed:", err.message);
  }
  col = interest;
  return col;
}

const withHash = (login) => `#${String(login).toLowerCase().replace(/^#/, "")}`;

async function messagesBetween(channelLogin, from, to) {
  const db = await connect();
  return db
    .collection("messages")
    .find({ channel: withHash(channelLogin), timestamp: { $gte: new Date(from), $lte: new Date(to) } }, { projection: { _id: 0, userId: 1, userName: 1, message: 1, sourceRoomId: 1 } })
    .limit(MESSAGES_MAX)
    .toArray();
}

const { cached } = createCache({ ttlMs: 10 * 60 * 1000, maxEntries: 50 });
async function emoteWords(channelLogin) {
  return cached(withHash(channelLogin), async () => {
    const db = await connect();
    return new Set((await db.collection("whiteList").find({ channel: withHash(channelLogin) }, { projection: { _id: 0, word: 1 } }).toArray()).map((r) => r.word));
  });
}

// song: { id, videoId, title, author, donation }
async function record(channelId, song, userIds) {
  if (userIds.length === 0) return;
  const interest = await ensureInitialized();
  const now = new Date();
  const { id, ...info } = song;
  await interest.bulkWrite(
    userIds.map((userId) => ({
      updateOne: {
        filter: { channelId: String(channelId), userId, id },
        update: { $set: { ...info, lastAt: now }, $setOnInsert: { firstAt: now }, $inc: { n: 1 } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

async function forChannel(channelId) {
  const interest = await ensureInitialized();
  return interest.find({ channelId: String(channelId) }).sort({ lastAt: -1 }).limit(ROWS_MAX).toArray();
}

async function channels() {
  const interest = await ensureInitialized();
  return interest.distinct("channelId");
}

module.exports = { messagesBetween, emoteWords, record, forChannel, channels };
