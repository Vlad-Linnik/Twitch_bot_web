// Web-only: MusicGraphDonations, one row per clip paid for and shown (lib/musicDonations.js):
//   { channelId, key, donor (a hash, or null), videoId, title, author, skipped, at (TTL a year) }
const { connectWeb } = require("./connection");

const KEEP_S = 365 * 24 * 60 * 60;
const ROWS_MAX = 20000;

let col;

async function ensureInitialized() {
  if (col) return col;
  const donations = (await connectWeb()).collection("MusicGraphDonations");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await Promise.all([
      donations.createIndex({ channelId: 1, key: 1 }, { unique: true }),
      donations.createIndex({ channelId: 1, at: -1 }),
      donations.createIndex({ at: 1 }, { expireAfterSeconds: KEEP_S }),
    ]);
  } catch (err) {
    console.error("[musicDonationsRepo] createIndex failed:", err.message);
  }
  col = donations;
  return col;
}

// A row already there is left as it is.
async function record(docs) {
  if (docs.length === 0) return;
  const donations = await ensureInitialized();
  await donations.bulkWrite(
    docs.map(({ channelId, key, ...rest }) => ({ updateOne: { filter: { channelId, key }, update: { $setOnInsert: rest }, upsert: true } })),
    { ordered: false }
  );
}

async function forChannel(channelId) {
  const donations = await ensureInitialized();
  return donations.find({ channelId: String(channelId) }).sort({ at: -1 }).limit(ROWS_MAX).toArray();
}

async function channels() {
  const donations = await ensureInitialized();
  return donations.distinct("channelId");
}

module.exports = { record, forChannel, channels };
