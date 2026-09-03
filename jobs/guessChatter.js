// Builds the question pool for "Угадай чатера" (db/guessChatterRepo.js).
//
// Its own directory rather than twitch/, for the same reason jobs/higherLowerExamples.js is here:
// the loops under twitch/ are there because they call Twitch's API, and this one only ever touches
// Mongo.
//
// ONE pass over the channel's messages does every author at once. `messages` has no text index and
// no per-author question index, so picking lines for one person costs a scan; picking them for
// fifty costs the same scan. Measured on production: the top 50 of #mistercop hold ~900k messages,
// of which ~287k survive the length/link/command/uniqueness rules and ~135k (38.1%) also clear
// MIN_CONTENT_WORDS - about 2700 strict questions per author.
const { connect } = require("../db/connection");
const channelsRepo = require("../db/channelsRepo");
const questionsRepo = require("../db/guessChatterRepo");
const { KNOWN_BOT_LOGINS } = require("../config/knownBots");
const gc = require("../lib/guessChatter");

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A pool of hundreds of thousands of lines does not turn over quickly, and a rebuild is a
// million-document read plus a comparable write - so a restart inside this window scans nothing.
const REBUILD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Authors are read deeper than the pool needs, because bots, bans and the per-author minimum all
// remove people after the ranking is taken.
const AUTHOR_SCAN_DEPTH = gc.POOL_SIZE * 3;

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

// The same three-set union the word cloud uses for "is this token an emote": currently tracked,
// ever counted, and tombstoned. Without it the tokenizer here would disagree with the one that
// wrote ChatWordStats, and MIN_CONTENT_WORDS would be counting emotes as words.
async function emotePredicate(db, channel) {
  const [white, life, excluded] = await Promise.all([
    db.collection("whiteList").distinct("word", { channel }),
    db.collection("WordLifetimeStats").distinct("word", { channel }),
    db.collection("EmoteExclusions").distinct("word", { channel }),
  ]);
  const set = new Set([...white, ...life, ...excluded].map((w) => String(w).toLowerCase()));
  return (token) => set.has(String(token).toLowerCase());
}

// Who may be asked about. Three exclusions, and the third is the one that needed a decision.
//
// ModeratorActionLogs records bans but NEVER unbans - Twitch's EventSub feed the bot subscribes to
// carries ban/timeout/delete/warn and nothing that lifts them - so "currently banned" is not
// directly derivable. Activity is the evidence instead: somebody who has posted since their last
// recorded ban is plainly back, and somebody who has not is treated as still gone. Erring this way
// costs at most a couple of names out of fifty, while the other direction puts a banned person's
// lines on a public page as a quiz about them.
async function eligibleAuthors(db, channelLogin) {
  const channel = withHash(channelLogin);

  const rows = await db
    .collection("UserLifetimeStats")
    .find({ channel }, { projection: { _id: 0, userId: 1, messageCount: 1, lastSeen: 1 } })
    .sort({ messageCount: -1 })
    .limit(AUTHOR_SCAN_DEPTH)
    .toArray();
  if (!rows.length) return [];

  const ids = rows.map((r) => r.userId);
  const idents = await db
    .collection("UserIdentities")
    .find({ userId: { $in: ids } }, { projection: { _id: 0, userId: 1, currentUserName: 1 } })
    .toArray();
  const loginOf = new Map(idents.map((i) => [i.userId, String(i.currentUserName || "").toLowerCase()]));

  const bans = await db
    .collection("ModeratorActionLogs")
    .find(
      { channel: String(channelLogin).replace(/^#/, ""), action: "ban", userId: { $in: ids } },
      { projection: { _id: 0, userId: 1, timestamp: 1 } }
    )
    .toArray();
  const lastBan = new Map();
  for (const b of bans) {
    const at = new Date(b.timestamp).getTime();
    if (!lastBan.has(b.userId) || lastBan.get(b.userId) < at) lastBan.set(b.userId, at);
  }

  const bots = new Set(KNOWN_BOT_LOGINS);
  const out = [];
  for (const row of rows) {
    const login = loginOf.get(row.userId);
    if (!login || bots.has(login)) continue;
    const banned = lastBan.get(row.userId);
    if (banned && !(row.lastSeen && new Date(row.lastSeen).getTime() > banned)) continue;
    out.push({ userId: row.userId, login });
    if (out.length >= gc.POOL_SIZE) break;
  }
  return out;
}

// Every message id a moderator acted on. Note what this actually links to: db/chatStats.js's
// addModeratorAction stores the target's LAST message before the action, which is the offending
// line in the ordinary case and merely the nearest one otherwise. Both are reasons to keep it out
// of a quiz.
async function moderatedMessageIds(db, channelLogin) {
  const rows = await db
    .collection("ModeratorActionLogs")
    .find(
      { channel: String(channelLogin).replace(/^#/, ""), messageId: { $ne: null } },
      { projection: { _id: 0, messageId: 1 } }
    )
    .toArray();
  return new Set(rows.map((r) => String(r.messageId)));
}

async function buildForChannel(channelLogin) {
  const db = await connect();
  const channel = withHash(channelLogin);

  const authors = await eligibleAuthors(db, channelLogin);
  if (authors.length < gc.MIN_CHANNEL_AUTHORS) {
    return { authors: authors.length, kept: 0, skipped: "too few authors" };
  }

  const [isEmote, moderated] = await Promise.all([
    emotePredicate(db, channel),
    moderatedMessageIds(db, channelLogin),
  ]);
  const loginOf = new Map(authors.map((a) => [a.userId, a.login]));

  // key -> row, plus the keys seen from more than one author. A line two people have both sent has
  // two right answers, so NEITHER copy may be asked - which is why the collision is remembered
  // rather than the first writer simply winning.
  const byKey = new Map();
  const collided = new Set();

  const cursor = db
    .collection("messages")
    .find({ channel, userId: { $in: authors.map((a) => a.userId) } })
    .project({ _id: 1, userId: 1, message: 1, gifs: 1, timestamp: 1 })
    .batchSize(2000);

  for await (const doc of cursor) {
    // A subscriber GIF's text is the GIPHY title in brackets - real words to a tokenizer, and
    // nobody's voice at all.
    if (doc.gifs && doc.gifs.length) continue;
    if (moderated.has(String(doc._id))) continue;
    if (!gc.isUsableLine(doc.message)) continue;

    const key = gc.questionKey(doc.message);
    if (collided.has(key)) continue;
    const seen = byKey.get(key);
    if (seen) {
      if (seen.userId !== doc.userId) {
        byKey.delete(key);
        collided.add(key);
      }
      continue;
    }
    byKey.set(key, {
      key,
      userId: doc.userId,
      login: loginOf.get(doc.userId),
      text: doc.message,
      ts: doc.timestamp,
      strict: gc.isStrictLine(doc.message, isEmote),
    });
  }

  // The per-author minimum is applied last: it counts what actually survived, not what the ranking
  // promised.
  const perAuthor = new Map();
  for (const row of byKey.values()) perAuthor.set(row.userId, (perAuthor.get(row.userId) || 0) + 1);
  const kept = [...byKey.values()].filter(
    (r) => perAuthor.get(r.userId) >= gc.MIN_QUESTIONS_PER_AUTHOR
  );
  const keptAuthors = new Set(kept.map((r) => r.userId));

  if (keptAuthors.size < gc.MIN_CHANNEL_AUTHORS) {
    return { authors: keptAuthors.size, kept: 0, skipped: "too few authors after filtering" };
  }

  const { written, removed } = await questionsRepo.replaceForChannel(channelLogin, kept);
  return {
    authors: keptAuthors.size,
    strict: kept.filter((r) => r.strict).length,
    kept: kept.length,
    written,
    removed,
  };
}

// Daily sweep, skipping any channel rebuilt inside REBUILD_AFTER_MS. Self-rescheduling and
// failure-tolerant in the same style as jobs/higherLowerExamples.js: one bad channel must never
// take the loop down with it.
function startGuessChatterRefreshLoop() {
  async function sweep() {
    let channels = [];
    try {
      channels = await channelsRepo.listEnabled();
    } catch (err) {
      console.error("[guessChatter] channel list failed:", err.message);
      return;
    }

    for (const channel of channels) {
      try {
        const built = await questionsRepo.lastBuiltAt(channel.channelLogin);
        if (built && Date.now() - built.getTime() < REBUILD_AFTER_MS) continue;
        const t0 = Date.now();
        const res = await buildForChannel(channel.channelLogin);
        if (res.skipped) {
          console.log(`[guessChatter] ${channel.channelLogin}: skipped - ${res.skipped}`);
          continue;
        }
        console.log(
          `[guessChatter] ${channel.channelLogin}: ${res.kept} questions ` +
            `(${res.strict} strict) from ${res.authors} authors, ${res.removed} stale removed, ` +
            `in ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      } catch (err) {
        console.error(`[guessChatter] ${channel.channelLogin} failed:`, err.message);
      }
    }
  }

  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = { buildForChannel, startGuessChatterRefreshLoop, REBUILD_AFTER_MS };
