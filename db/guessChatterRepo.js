// The question pool for "Угадай чатера" (/games/guess-chatter): one document per chat line that
// may be shown, with the author it belongs to. jobs/guessChatter.js fills it.
//
// Web-only db, like db/higherLowerExamplesRepo.js and for the same reason: every line in here came
// out of the bot-owned `messages`, but the bot never reads this back - it is a pool the site
// precomputes for itself, and putting it in the shared database would claim otherwise.
//
// PRIVACY, deliberate and already established by HigherLowerExamples: a raw chat line is otherwise
// gated on this site (log search is requireLevel(2), the per-user page needs a login) while counts
// are public. This collection puts individual lines on a public page and names their author. The
// difference here is that naming the author IS the game rather than an attribution under a
// quotation, so the exclusions are wider - see jobs/guessChatter.js: nothing from a known bot,
// nothing a moderator acted on, nobody currently banned.
//
// {channel, userId, login, text, key, strict, ts, builtAt}
//   channel - login WITHOUT '#' (the `messages` collection's own key carries one; withHash() below)
//   key     - lib/guessChatter.js questionKey(), the uniqueness key the build dedupes on
//   strict  - passed MIN_CONTENT_WORDS; false rows are the deliberate admixture, see pickRunQuestions
//   ts      - the original message timestamp, the anchor the context lookup needs
const { connect, connectWeb } = require("./connection");
const gc = require("../lib/guessChatter");

let collection;

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("GuessChatterQuestions");
  // Index creation must not be able to fail a page render: the handle is cached above, so a throw
  // here would 500 only the first request after a restart and heal silently on the next one.
  try {
    await collection.createIndex({ channel: 1, key: 1 }, { unique: true });
    await collection.createIndex({ channel: 1, strict: 1 });
    await collection.createIndex({ channel: 1, userId: 1, strict: 1 });
    await collection.createIndex({ channel: 1, builtAt: -1 });
  } catch (err) {
    console.error("[GuessChatterQuestions] index creation failed:", err.message);
  }
  return collection;
}

// ---------------------------------------------------------------------------------------
// Reading the pool
// ---------------------------------------------------------------------------------------

// The channel's candidate authors, with the login each was last seen under. Derived rather than
// kept in a collection of its own: the pool IS whoever has questions, so it cannot go stale
// against the questions themselves.
//
// Cached because deriving it is a $group over the channel's whole pool - measured at 868ms against
// 281k rows - and it sits on the "Играть" click. The answer only changes when the weekly rebuild
// runs, so anything shorter than that is already conservative.
const authorCache = new Map();
const AUTHOR_CACHE_MS = 10 * 60 * 1000;

async function getAuthors(channelLogin) {
  const hit = authorCache.get(channelLogin);
  if (hit && Date.now() - hit.at < AUTHOR_CACHE_MS) return hit.rows;

  const col = await ensureInitialized();
  const rows = await col
    .aggregate([
      { $match: { channel: channelLogin } },
      { $group: { _id: "$userId", login: { $first: "$login" }, questions: { $sum: 1 } } },
      { $match: { questions: { $gte: gc.MIN_QUESTIONS_PER_AUTHOR } } },
      { $sort: { questions: -1 } },
      { $limit: gc.POOL_SIZE },
    ])
    .toArray();

  const authors = rows.map((r) => ({ userId: r._id, login: r.login, questions: r.questions }));
  authorCache.set(channelLogin, { at: Date.now(), rows: authors });
  return authors;
}

// Channel list for the picker. One aggregation for every channel at once rather than one each,
// and cached: it is a $group over the whole pool and the answer changes only when the weekly
// rebuild runs.
let channelCache = { at: 0, rows: null };
const CHANNEL_CACHE_MS = 5 * 60 * 1000;

async function listPlayableChannels(channels) {
  if (channelCache.rows && Date.now() - channelCache.at < CHANNEL_CACHE_MS) {
    return channelCache.rows.filter((r) => channels.some((c) => c.channelLogin === r.channelLogin));
  }
  const col = await ensureInitialized();
  const rows = await col
    .aggregate([
      { $group: { _id: { channel: "$channel", userId: "$userId" }, questions: { $sum: 1 } } },
      { $match: { questions: { $gte: gc.MIN_QUESTIONS_PER_AUTHOR } } },
      { $group: { _id: "$_id.channel", authors: { $sum: 1 }, questions: { $sum: "$questions" } } },
    ])
    .toArray();

  const playable = rows
    .filter((r) => gc.isChannelPlayable(r.authors))
    .map((r) => ({ channelLogin: r._id, authors: Math.min(r.authors, gc.POOL_SIZE), questions: r.questions }))
    .sort((a, b) => b.questions - a.questions);

  channelCache = { at: Date.now(), rows: playable };
  return playable.filter((r) => channels.some((c) => c.channelLogin === r.channelLogin));
}

// The raw material for one run: a random draw of strict lines and a smaller one of admixed lines.
// Drawn wider than ROUNDS because pickOptions can refuse a question whose @-mentions leave too few
// legal decoys, and a refused question should cost a spare rather than a round.
async function drawQuestions(channelLogin, poolUserIds, spare = 6) {
  const col = await ensureInitialized();
  const inPool = { channel: channelLogin, userId: { $in: poolUserIds } };
  const [strict, loose] = await Promise.all([
    col.aggregate([{ $match: { ...inPool, strict: true } }, { $sample: { size: gc.ROUNDS + spare } }]).toArray(),
    col.aggregate([{ $match: { ...inPool, strict: false } }, { $sample: { size: gc.LOOSE_ROUNDS + spare } }]).toArray(),
  ]);
  return { strict, loose };
}

// Candidate hint lines for one author. Asked per author rather than in one big $sample so that a
// quiet author still gets their own draw instead of losing it to a loud one.
async function drawAuthorLines(channelLogin, userId, size) {
  const col = await ensureInitialized();
  return col
    .aggregate([
      { $match: { channel: channelLogin, userId, strict: true } },
      { $sample: { size } },
    ])
    .toArray();
}

async function findById(channelLogin, id) {
  const col = await ensureInitialized();
  return col.findOne({ _id: id, channel: channelLogin });
}

// ---------------------------------------------------------------------------------------
// The context view
// ---------------------------------------------------------------------------------------

// Reads the SHARED database - `messages` is the bot's, and this is a read, which the repo rule in
// ../CLAUDE.md permits (it is writes to a bot-owned collection that need a contract). Two bounded
// range scans around the anchor rather than one wide one, so "5 before" cannot be swallowed by a
// busy second.
async function getContext(channelLogin, ts, before, after) {
  const db = await connect();
  const channel = withHash(channelLogin);
  const [pre, post] = await Promise.all([
    db
      .collection("messages")
      .find({ channel, timestamp: { $lt: ts } })
      .project({ _id: 0, userName: 1, message: 1, timestamp: 1 })
      .sort({ timestamp: -1 })
      .limit(before)
      .toArray(),
    db
      .collection("messages")
      .find({ channel, timestamp: { $gt: ts } })
      .project({ _id: 0, userName: 1, message: 1, timestamp: 1 })
      .sort({ timestamp: 1 })
      .limit(after)
      .toArray(),
  ]);
  return [...pre.reverse(), ...post];
}

// ---------------------------------------------------------------------------------------
// Writing (the job)
// ---------------------------------------------------------------------------------------

async function lastBuiltAt(channelLogin) {
  const col = await ensureInitialized();
  const row = await col.findOne(
    { channel: channelLogin },
    { sort: { builtAt: -1 }, projection: { _id: 0, builtAt: 1 } }
  );
  return row ? row.builtAt : null;
}

// Replaces this channel's pool. Batched rather than one bulkWrite because a full pool is hundreds
// of thousands of rows; the sweep of everything older than this build runs afterwards, so a line
// that stopped qualifying (its author left the top 50, a moderator acted on it) stops being asked.
async function replaceForChannel(channelLogin, rows, builtAt = new Date()) {
  const col = await ensureInitialized();
  const BATCH = 1000;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await col.bulkWrite(
      slice.map((r) => ({
        updateOne: {
          filter: { channel: channelLogin, key: r.key },
          update: { $set: { ...r, channel: channelLogin, builtAt } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    written += slice.length;
  }

  const stale = await col.deleteMany({ channel: channelLogin, builtAt: { $lt: builtAt } });
  // Both caches describe what was just replaced, so a rebuild has to drop them rather than wait
  // out their TTL - otherwise a channel that just became playable stays out of the picker.
  channelCache = { at: 0, rows: null };
  authorCache.delete(channelLogin);
  return { written, removed: stale.deletedCount };
}

module.exports = {
  getAuthors,
  listPlayableChannels,
  drawQuestions,
  drawAuthorLines,
  findById,
  getContext,
  lastBuiltAt,
  replaceForChannel,
  withHash,
};
