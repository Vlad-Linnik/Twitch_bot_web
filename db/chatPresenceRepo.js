// "Has this account ever written in this channel's chat?" - read from the bot's UserLifetimeStats
// (twitch_chat_stats, key {channel: '#<login>', userId}, unique index). The site only reads it.
//
// Used to decide whether a viewer's rating of a movie card counts: an account made to stuff a
// rating has never been in the channel's chat, which no outside rating site can check.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("UserLifetimeStats");
  return collection;
}

async function hasChatted(channelLogin, userId) {
  if (!channelLogin || !userId) return false;
  const col = await ensureInitialized();
  const row = await col.findOne(
    { channel: `#${channelLogin.toLowerCase()}`, userId: String(userId), messageCount: { $gt: 0 } },
    { projection: { _id: 1 } }
  );
  return Boolean(row);
}

module.exports = { hasChatted };
