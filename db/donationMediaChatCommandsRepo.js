// DonationMediaChatCommands - a moderator's `!clip ...` typed in chat, on its way from the bot to
// the queue. SHARED db, written by both repos asymmetrically, like LongBans: the queue lives only in
// this process's memory (realtime/donationMediaManager.js), the chat lives only in the bot, and the
// two never call each other.
//
//   { channelId,              string, numeric Twitch id
//     action,                 "hide" | "show" | "pause" | "play" | "skip" (lib/donationMediaChatCommand.js)
//     itemId,                 integer, DonationMediaNowPlaying.item.id the moderator was looking at
//     by: { userId, login },  the moderator, as the bot saw them (userId is Twitch's numeric id)
//     status,                 "pending"  - written by the bot (TwitchBot commands/donationMediaControl.js)
//                             "handling" - taken by claim(), a moment before finish()
//                             anything else - written here, once, by finish():
//                               "done" | "noop" | "changed" | "forbidden" | "expired" | "invalid"
//     createdAt, handledAt }
//
// The bot inserts the row and polls it for a few seconds to say the outcome in chat; it never
// changes a row after inserting it. This side never inserts one. A row not picked up within
// MAX_AGE_MS is expired rather than run: a skip carried out a minute late (the web process was
// restarting) is a skip of something nobody asked to skip - itemId would usually catch that, but
// "pause" on a clip that is still playing would not. Rows are deleted by a TTL index after a day;
// they are a hand-off, not an audit trail (a skip is recorded in the queue's history with `by`).
const { connect } = require("./connection");

const COLLECTION = "DonationMediaChatCommands";
const MAX_AGE_MS = 30 * 1000;
const TTL_SECONDS = 24 * 3600;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  const col = db.collection(COLLECTION);
  try {
    await col.createIndex({ status: 1, createdAt: 1 });
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
  } catch (err) {
    console.error("[donationMedia] DonationMediaChatCommands index:", err.message);
  }
  collection = col;
  return col;
}

// Takes the oldest pending command, marking it so it is not taken twice. Null when none is waiting.
async function claim() {
  const col = await ensureInitialized();
  return col.findOneAndUpdate(
    { status: "pending" },
    { $set: { status: "handling", handledAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  );
}

async function finish(id, status) {
  const col = await ensureInitialized();
  await col.updateOne({ _id: id }, { $set: { status, handledAt: new Date() } });
}

module.exports = { claim, finish, COLLECTION, MAX_AGE_MS };
