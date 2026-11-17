// Boards made from a channel's emotes for "Укладка" (lib/tileFitEmoteBoard.js), kept so an emote's
// picture is fetched and shrunk once a week rather than on every visit. Web db (connectWeb) - the
// bot never reads it. One doc per (channelLogin, emote): {mask, colors, builtAt}, or
// {empty: true} for an emote whose picture does not make a board, so it is not retried every time.
const { connectWeb } = require("./connection");

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  const col = db.collection("TileFitEmoteBoards");
  try {
    await col.createIndex({ channelLogin: 1, emote: 1 }, { unique: true });
  } catch (err) {
    console.error("[tileFitEmoteBoards] index creation failed:", err.message);
  }
  collection = col;
  return collection;
}

async function getFresh(channelLogin, emotes) {
  const col = await ensureInitialized();
  const docs = await col
    .find({ channelLogin, emote: { $in: emotes }, builtAt: { $gt: new Date(Date.now() - MAX_AGE_MS) } })
    .toArray();
  return new Map(docs.map((d) => [d.emote, d]));
}

async function save(channelLogin, emote, board) {
  const col = await ensureInitialized();
  await col.updateOne(
    { channelLogin, emote },
    {
      $set: board
        ? { mask: board.mask, colors: board.colors, empty: false, builtAt: new Date() }
        : { empty: true, builtAt: new Date() },
    },
    { upsert: true }
  );
}

module.exports = { getFresh, save };
