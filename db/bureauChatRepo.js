// The live chat feed behind the Бюро амнистии's street: the crowd's speech bubbles and the vote
// emotes that fly into the scoreboard (public/js/games/unban-bureau.js). Read-only over the bot's
// `messages` collection (shape owned by TwitchBot/db/chatStats.js) - nothing here writes.
//
// A cursor, not a window: the page passes back the timestamp of the last line it was given and gets
// only what came after, so a 3s poll costs one bounded index scan on {channel, timestamp} and the
// same line is never shown twice. The very first poll returns no lines at all, only a cursor at the
// newest stored line - the street starts talking from the moment the page opened, rather than
// replaying a backlog of bubbles nobody is still talking about. The cursor is a time the DATABASE
// produced (the bot's own clock), never this process's Date.now(), so the two processes' clocks
// never have to agree.
const { connect } = require("./connection");
const { isKnownBotName } = require("../config/knownBots");

// Per poll. A raid writes far more than a street can show in 3s; the client keeps fewer still
// (BureauCrowdFx.paceLines), this just bounds the response.
const MAX_LINES = 25;
// The bubble shows a few dozen characters; the rest is never sent.
const MAX_TEXT = 200;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("messages");
  return collection;
}

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

function parseCursor(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readChatSince(channelLogin, rawCursor) {
  const col = await ensureInitialized();
  const channel = withHash(channelLogin);
  const after = parseCursor(rawCursor);

  if (after === null) {
    const newest = await col.findOne(
      { channel },
      { sort: { timestamp: -1 }, projection: { timestamp: 1 } }
    );
    return { lines: [], cursor: newest?.timestamp ? newest.timestamp.getTime() : Date.now() };
  }

  const rows = await col
    .find(
      { channel, timestamp: { $gt: new Date(after) } },
      { projection: { userId: 1, userName: 1, message: 1, timestamp: 1 } }
    )
    .sort({ timestamp: -1 })
    .limit(MAX_LINES)
    .toArray();
  rows.reverse();

  const cursor = rows.length ? rows[rows.length - 1].timestamp.getTime() : after;
  const lines = rows
    // The bot's own vote prompt names both emotes and would fly as a vote. Chat bots are not the
    // crowd either way.
    .filter((row) => !isKnownBotName(row.userName))
    .map((row) => ({
      id: String(row._id),
      userId: row.userId ? String(row.userId) : "",
      userName: String(row.userName || ""),
      // By code point, so an emoji at the cut isn't sent as half a surrogate pair.
      text: Array.from(String(row.message || "")).slice(0, MAX_TEXT).join(""),
      at: row.timestamp.getTime(),
    }));
  return { lines, cursor };
}

module.exports = { readChatSince, MAX_LINES, MAX_TEXT };
