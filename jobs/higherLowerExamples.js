// Builds the chat-line examples shown under words in "Выше — ниже" (db/higherLowerExamplesRepo.js).
//
// Its own directory rather than twitch/: the two loops living there (profileCacheScheduler,
// moderatorSyncScheduler) are there because they call Twitch's API, and this one only ever touches
// Mongo. Filing a database job under twitch/ would say something untrue about what it does.
//
// ONE pass over the channel's messages fills every word at once. That is the whole reason this is
// a job and not a lookup: `messages` has no text index, so finding a line for a single word costs
// a collection scan (measured: 65ms to 10.4s, sometimes finding nothing), while finding lines for
// every word costs exactly the same one scan. Measured on production data, 1.93M messages take
// ~21 seconds and cover 99.3% of the pool at roughly half a megabyte per channel.
const { connect } = require("../db/connection");
const examplesRepo = require("../db/higherLowerExamplesRepo");
const channelsRepo = require("../db/channelsRepo");
const { extractWords, LIFETIME_BUCKET } = require("../lib/textStats");
const { isUsable, isBetter, MAX_LENGTH } = require("../lib/higherLowerExample");
const hl = require("../lib/higherLower");

// The lowest count any word mode/period asks for, so one build serves both. A word in the month
// pool is NOT necessarily in the all-time pool (25 uses this month, 90 all time), so this cannot
// simply mirror WORD_MIN_COUNT.all.
const EXAMPLE_MIN_COUNT = Math.min(...Object.values(hl.WORD_MIN_COUNT));

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A pool of words used a hundred times each does not turn over quickly, and a rebuild is a
// two-million-document read - so a restart inside this window scans nothing.
const REBUILD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

// The same three-set union the word cloud uses for "is this token an emote": currently tracked,
// ever counted, and tombstoned. Without it the tokenizer here would disagree with the one that
// wrote ChatWordStats, and examples would be attached to words the game never deals.
async function emotePredicate(db, channel) {
  const [white, life, excluded] = await Promise.all([
    db.collection("whiteList").distinct("word", { channel }),
    db.collection("WordLifetimeStats").distinct("word", { channel }),
    db.collection("EmoteExclusions").distinct("word", { channel }),
  ]);
  const set = new Set([...white, ...life, ...excluded].map((w) => String(w).toLowerCase()));
  return (token) => set.has(String(token).toLowerCase());
}

async function buildForChannel(channelLogin) {
  const db = await connect();
  const channel = withHash(channelLogin);

  const pool = new Set(
    (
      await db
        .collection("ChatWordStats")
        .find({ channel, date: LIFETIME_BUCKET, count: { $gte: EXAMPLE_MIN_COUNT } })
        .project({ _id: 0, word: 1 })
        .toArray()
    ).map((r) => r.word)
  );
  if (pool.size === 0) return { pool: 0, found: 0 };

  const isEmote = await emotePredicate(db, channel);
  const found = new Map();

  const cursor = db
    .collection("messages")
    .find({ channel })
    .project({ _id: 0, message: 1, gifs: 1, userName: 1 })
    .batchSize(2000);

  for await (const doc of cursor) {
    // A subscriber GIF's text is the GIPHY title in brackets - real words to a tokenizer, and
    // nonsense as an example of anyone saying anything. Skipping the message is simpler than
    // blanking the span and then judging what is left.
    if (doc.gifs && doc.gifs.length) continue;

    const text = String(doc.message || "").trim();
    if (!text || text.length > MAX_LENGTH) continue;

    // The name as it stood when the line was written, not whoever holds that account today: a
    // rename should not rewrite the attribution on an old quotation. `messages.userName` is the
    // login, which is what chat showed at the time.
    const author = String(doc.userName || "") || null;

    for (const word of extractWords(text, isEmote)) {
      if (!pool.has(word)) continue;
      if (!isUsable(text, word)) continue;
      const current = found.get(word);
      if (isBetter(text, current ? current.text : null)) found.set(word, { text, author });
    }
  }

  const { written, removed } = await examplesRepo.replaceForChannel(channelLogin, [...found]);
  return { pool: pool.size, found: found.size, written, removed };
}

// Daily sweep, skipping any channel scanned inside REBUILD_AFTER_MS. Self-rescheduling and
// failure-tolerant in the same style as twitch/profileCacheScheduler.js: one bad channel must
// never take the loop down with it.
function startExampleRefreshLoop() {
  async function sweep() {
    let channels = [];
    try {
      channels = await channelsRepo.listEnabled();
    } catch (err) {
      console.error("[higherLowerExamples] channel list failed:", err.message);
      return;
    }

    for (const channel of channels) {
      try {
        const built = await examplesRepo.lastBuiltAt(channel.channelLogin);
        if (built && Date.now() - built.getTime() < REBUILD_AFTER_MS) continue;
        const t0 = Date.now();
        const res = await buildForChannel(channel.channelLogin);
        if (res.pool === 0) continue;
        console.log(
          `[higherLowerExamples] ${channel.channelLogin}: ${res.found}/${res.pool} words got a line ` +
            `(${res.removed} stale removed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      } catch (err) {
        console.error(`[higherLowerExamples] ${channel.channelLogin} failed:`, err.message);
      }
    }
  }

  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = { buildForChannel, startExampleRefreshLoop, EXAMPLE_MIN_COUNT, REBUILD_AFTER_MS };
