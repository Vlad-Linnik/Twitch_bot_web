// One real chat line per word, shown under that word on a "Выше — ниже" card.
//
// Web-only db, even though every line in it came out of the bot-owned `messages`: the bot never
// reads this, it is a rendering aid the site builds for itself, and putting it in the shared
// database would imply otherwise. jobs/higherLowerExamples.js fills it.
//
// PRIVACY NOTE, deliberate: everywhere else on this site a raw chat message is gated - the log
// search is requireLevel(2) and the per-user page needs a login - while word counts are public.
// This collection puts individual lines on a public page, attributed by name. Both steps were
// taken as product decisions with the gap pointed out, the attribution after the sentence itself:
// what is published is a quotation, the way a quotation is normally published.
//
// {channel, word, text, author, builtAt, v}
const { connectWeb } = require("./connection");

let collection;

// The shape a build writes. Bumped whenever this job starts filling a field the cards read, so
// jobs/higherLowerExamples.js can tell its own output from an older version's and rebuild.
//
// It exists because of what happened without it: attribution shipped after the first build, the
// rows already on production had no `author` at all, and a rebuild was only ever due on AGE - so
// every quotation on the site stood unsigned, correctly rendered and empty, until the week ran
// out. Age answers "has the chat moved on"; this answers "is this row shaped the way the page now
// reads it", and they are not the same question.
//
// v1 rows carry no `v` and no `author`. Nothing migrates them: a build replaces the channel's set
// outright, which is cheaper than a backfill and is going to run anyway.
const SHAPE_VERSION = 2;

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

// word -> {text, author}, for the handful of words a round actually shows. `author` is null when
// the line's writer could not be named at all; the card then shows the quote unsigned rather than
// nothing. A row from an older shape has no author either - hasStaleShape() below is what gets
// those rebuilt rather than served unsigned until REBUILD_AFTER_MS runs out.
async function getExamples(channelLogin, words) {
  if (!words || words.length === 0) return new Map();
  const col = await ensureInitialized();
  const rows = await col
    .find({ channel: channelLogin, word: { $in: words } })
    .project({ _id: 0, word: 1, text: 1, author: 1 })
    .toArray();
  return new Map(rows.map((r) => [r.word, { text: r.text, author: r.author || null }]));
}

// Whether any of this channel's rows were written by a build older than SHAPE_VERSION. Counted
// with a limit rather than fetched: the answer is yes/no, and the {channel, word} index carries
// it. A row the current build wrote always has the field, even when the author came out null, so
// this settles once the rebuild has run and cannot loop a channel into rebuilding every sweep.
async function hasStaleShape(channelLogin) {
  const col = await ensureInitialized();
  const behind = await col.countDocuments({ channel: channelLogin, v: { $ne: SHAPE_VERSION } }, { limit: 1 });
  return behind > 0;
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
      slice.map(([word, entry]) => {
        words.push(word);
        return {
          updateOne: {
            filter: { channel: channelLogin, word },
            update: {
              $set: {
                channel: channelLogin,
                word,
                text: entry.text,
                author: entry.author || null,
                builtAt,
                v: SHAPE_VERSION,
              },
            },
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

module.exports = { getExamples, lastBuiltAt, hasStaleShape, replaceForChannel, SHAPE_VERSION };
