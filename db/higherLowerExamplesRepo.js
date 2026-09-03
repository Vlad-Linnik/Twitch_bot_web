// One real chat line per word, shown under that word on a "Выше — ниже" card.
//
// Web-only db, even though every line in it came out of the bot-owned `messages`: the bot never
// reads this, it is a rendering aid the site builds for itself, and putting it in the shared
// database would imply otherwise. jobs/higherLowerExamples.js fills it.
//
// PRIVACY NOTE, deliberate: everywhere else on this site a raw chat message is gated - the log
// search is requireLevel(2) and the per-user page needs a login - while word counts are public.
// This collection puts individual lines on a public page. That is a product decision, taken with
// the gap pointed out; the line carries no author, here or in the document, so what is published
// is the sentence and not who said it.
//
// {channel, word, text, builtAt}
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("HigherLowerExamples");
  // Index creation must not be able to fail a page render - the handle is already cached above,
  // so a throw here would 500 only the first request after a restart and heal on the next.
  try {
    await collection.createIndex({ channel: 1, word: 1 }, { unique: true });
    await collection.createIndex({ channel: 1, builtAt: -1 });
  } catch (err) {
    console.error("[HigherLowerExamples] index creation failed:", err.message);
  }
  return collection;
}

// word -> text, for the handful of words a round actually shows.
async function getExamples(channelLogin, words) {
  if (!words || words.length === 0) return new Map();
  const col = await ensureInitialized();
  const rows = await col
    .find({ channel: channelLogin, word: { $in: words } })
    .project({ _id: 0, word: 1, text: 1 })
    .toArray();
  return new Map(rows.map((r) => [r.word, r.text]));
}

// When this channel was last scanned, or null if never. Drives the freshness check that keeps a
// restart from re-scanning two million messages for nothing.
async function lastBuiltAt(channelLogin) {
  const col = await ensureInitialized();
  const row = await col.findOne({ channel: channelLogin }, { sort: { builtAt: -1 }, projection: { _id: 0, builtAt: 1 } });
  return row ? row.builtAt : null;
}

// Replaces this channel's set. Written in batches rather than one bulkWrite because a full pool is
// thousands of rows; the delete of what the scan no longer found runs after, so a word that lost
// its example (its lines all got shorter than the rule allows) stops being served a stale one.
async function replaceForChannel(channelLogin, entries, builtAt = new Date()) {
  const col = await ensureInitialized();
  const BATCH = 500;
  const words = [];

  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    await col.bulkWrite(
      slice.map(([word, text]) => {
        words.push(word);
        return {
          updateOne: {
            filter: { channel: channelLogin, word },
            update: { $set: { channel: channelLogin, word, text, builtAt } },
            upsert: true,
          },
        };
      }),
      { ordered: false }
    );
  }

  const stale = await col.deleteMany({ channel: channelLogin, builtAt: { $lt: builtAt } });
  return { written: words.length, removed: stale.deletedCount };
}

module.exports = { getExamples, lastBuiltAt, replaceForChannel };
