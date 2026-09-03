// The emotes the BOT learnt from chat rather than fetched from a list, read-only.
//
// TwitchBot/db/chatStats.js owns the shape: rows in the shared `whiteList` collection under
// source 'twitch-external', written one at a time from the IRC `emotes` tag when a viewer types
// a Twitch emote this channel does not have - a sub, bits or follower emote of some OTHER
// broadcaster, which Twitch renders for anyone who owns it, anywhere on Twitch.
//
// Why this needs its own module at all: for every other emote source the site resolves pictures
// itself, from the same provider the bot synced the names from (twitch/emoteImages.js). These
// belong to a broadcaster nobody here can name, so there is no set to look them up in - the
// emote id the bot captured off the tag is the only route to a picture, and this row is the only
// place it exists.
const { connect } = require("./connection");

let collection;

const EXTERNAL_SOURCE = "twitch-external";

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("whiteList");
  return collection;
}

/**
 * [{ word, emoteId }] for one channel - the spelling that renders, and Twitch's id for it.
 * Rows with no id (there should be none; a defensive filter, since a row without one resolves
 * to no picture anyway) are dropped here rather than downstream.
 */
async function listExternalEmotes(channelLogin) {
  const col = await ensureInitialized();
  const rows = await col
    .find(
      { channel: withHash(channelLogin), source: EXTERNAL_SOURCE },
      { projection: { _id: 0, word: 1, emoteId: 1 } }
    )
    .toArray();
  return rows.filter((row) => row.word && row.emoteId);
}

module.exports = { listExternalEmotes, EXTERNAL_SOURCE };
