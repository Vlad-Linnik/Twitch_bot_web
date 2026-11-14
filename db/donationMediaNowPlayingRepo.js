// DonationMediaNowPlaying - the one piece of the donation media feature the bot reads: what the
// channel's OBS player is showing right now, for the chat command that names the current clip
// (TwitchBot commands/msgHandle.js, `track`). It lives in the SHARED db, unlike the queue and the
// platform keys (db/donationMediaRepo.js, web db), precisely because the bot reads it; it carries
// nothing the bot does not need - no keys, no queue, no history.
//
// One row per channel, written by realtime/donationMediaManager.js and only by it:
//   { channelId,                       string, numeric Twitch id
//     channelLogin,                    without "#", for a human reading the collection
//     item: null | { id, videoId, title, donor, amount: { value, currency } | null,
//                    platform, addedBy },
//                                  `id` is the queue's own item id; the bot sends it back with a
//                                  `!clip` command (db/donationMediaChatCommandsRepo.js)
//     paused,                          boolean
//     startedAt,                       Date the clip started playing (null with no item)
//     updatedAt }                      Date of the last write
//
// `item: null` means nothing plays. The row is re-written while a clip plays (REFRESH_MS in the
// manager), so a row whose updatedAt is old says the web process is gone and is to be read as
// "nothing plays" - the bot does exactly that, it never trusts an old row.
const { connect } = require("./connection");

const COLLECTION = "DonationMediaNowPlaying";

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  const col = db.collection(COLLECTION);
  try {
    await col.createIndex({ channelId: 1 }, { unique: true });
  } catch (err) {
    console.error("[donationMedia] DonationMediaNowPlaying index:", err.message);
  }
  collection = col;
  return col;
}

async function setNowPlaying(channelId, channelLogin, { item, paused, startedAt }) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelId: String(channelId) },
    {
      $set: {
        channelId: String(channelId),
        channelLogin,
        item: item || null,
        paused: Boolean(item && paused),
        startedAt: item ? startedAt || new Date() : null,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

module.exports = { setNowPlaying, COLLECTION };
