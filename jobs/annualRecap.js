// Builds a channel's annual recap (/:channel/recap) into AnnualRecaps - see db/annualRecapRepo.js
// for the storage and lib/annualRecap.js for what every number means.
//
// ONE time-ordered pass over the year's `messages` fills everything that needs the raw text or the
// author (sessions, hours, loud minutes, who @-ed whom, commands, the first author of a new word),
// plus aggregations over the daily rows for what is already counted (words, emotes). It is the same
// shape of work as jobs/higherLowerExamples.js, which reads ~2M messages in about twenty seconds.
//
// Runs from the admin panel's button, and once a day for every channel whose recap section is
// switched on: the current year keeps growing until it ends, and a finished year gets one last
// build after its final day.
const { connect } = require("../db/connection");
const channelsRepo = require("../db/channelsRepo");
const recapRepo = require("../db/annualRecapRepo");
const { emotePredicate } = require("../db/emotePredicate");
const { KNOWN_BOT_LOGINS } = require("../config/knownBots");
const { LIFETIME_BUCKET } = require("../lib/textStats");
const recap = require("../lib/annualRecap");

const withHash = (login) => `#${String(login).toLowerCase().replace(/^#/, "")}`;

// A viewer sample further than this from a message says nothing about what was on screen.
const CATEGORY_MAX_GAP_MS = 10 * 60 * 1000;
// A word needs this many uses in the year to be a "new word of the year".
const NEW_WORD_MIN_USES = 30;
// New words are only meaningful against a history: a word is "new" when the index has watched the
// chat for a while without seeing it. With less history than this before the year starts, every
// word would be new.
const NEW_WORD_MIN_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
// Fewer actions than this and a moderator's median reaction time is luck.
const MOD_MIN_ACTIONS = 20;
const TOP_LIST = 30; // stored with headroom: the page drops people who opted out
const MENTION_MIN_STORED = 2;

const { reasonKind } = recap;

// Binary search over samples sorted by time: the category on screen at `ts`, or null.
function categoryNear(samples, ts) {
  let lo = 0;
  let hi = samples.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= ts) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === -1 || ts - samples[best].t > CATEGORY_MAX_GAP_MS) return null;
  return samples[best].category || null;
}

function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function topAndTotal(db, collection, channel, start, end, limit) {
  const [res] = await db
    .collection(collection)
    .aggregate(
      [
        { $match: { channel, date: { $gte: start, $lt: end } } },
        {
          $facet: {
            top: [{ $group: { _id: "$word", n: { $sum: "$count" } } }, { $sort: { n: -1 } }, { $limit: limit }],
            total: [{ $group: { _id: null, n: { $sum: "$count" } } }],
          },
        },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  return { top: res.top.map((r) => ({ word: r._id, n: r.n })), total: res.total[0]?.n || 0 };
}

async function monthlyCurves(db, collection, channel, words, start, end) {
  if (!words.length) return {};
  const rows = await db
    .collection(collection)
    .aggregate([
      { $match: { channel, word: { $in: words }, date: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: { w: "$word", m: { $month: { date: "$date", timezone: "+03:00" } } },
          n: { $sum: "$count" },
        },
      },
    ])
    .toArray();
  const curves = {};
  for (const w of words) curves[w] = new Array(12).fill(0);
  for (const r of rows) curves[r._id.w][r._id.m - 1] = r.n;
  return curves;
}

async function newWordCandidates(db, channel, start, end) {
  const earliest = await db
    .collection("ChatWordStats")
    .find({ channel, date: { $gt: LIFETIME_BUCKET } })
    .project({ date: 1 })
    .sort({ date: 1 })
    .limit(1)
    .toArray();
  if (!earliest.length || start.getTime() - earliest[0].date.getTime() < NEW_WORD_MIN_HISTORY_MS) return [];
  return db
    .collection("ChatWordStats")
    .aggregate(
      [
        { $match: { channel, date: { $gt: LIFETIME_BUCKET, $lt: end } } },
        {
          $group: {
            _id: "$word",
            first: { $min: "$date" },
            n: { $sum: { $cond: [{ $gte: ["$date", start] }, "$count", 0] } },
          },
        },
        { $match: { first: { $gte: start }, n: { $gte: NEW_WORD_MIN_USES } } },
        { $sort: { n: -1 } },
        { $limit: 40 },
      ],
      { allowDiskUse: true }
    )
    .toArray();
}

async function buildChannelRecap(channelLogin, year) {
  const db = await connect();
  const login = String(channelLogin).toLowerCase();
  const channel = withHash(login);
  const channelDoc = await channelsRepo.findByLogin(login);
  if (!channelDoc) throw new Error(`unknown channel ${login}`);
  const channelId = String(channelDoc.channelId);
  const { start, end } = recap.yearRange(year);
  const t0 = Date.now();

  const botLogins = new Set(KNOWN_BOT_LOGINS.map((l) => l.toLowerCase()));

  const [isEmote, words, emotes, newWords, samplesRaw] = await Promise.all([
    emotePredicate(db, channel),
    topAndTotal(db, "ChatWordStats", channel, start, end, 80),
    topAndTotal(db, "words", channel, start, end, 40),
    newWordCandidates(db, channel, start, end),
    db
      .collection("StreamViewerSamples")
      .find({ channelId, timestamp: { $gte: start, $lt: end } })
      .project({ _id: 0, timestamp: 1, category: 1, viewerCount: 1 })
      .sort({ timestamp: 1 })
      .toArray(),
  ]);
  // ChatWordStats still holds rows for tokens learnt to be emotes after they were counted (see
  // CLAUDE.md "Words vs emotes"); the same predicate the word cloud uses keeps them out of the word
  // lists, where an emote is not a word and certainly not one the chat invented.
  words.top = words.top.filter((w) => !isEmote(w.word));
  const newWordRows = newWords.filter((w) => !isEmote(w._id));

  const samples = samplesRaw.map((s) => ({ t: s.timestamp.getTime(), category: s.category, viewers: s.viewerCount }));

  const acc = recap.createChannelAccumulator({
    isEmote,
    botLogins,
    candidateWords: new Set(newWordRows.map((w) => w._id)),
    broadcasterLogin: login,
    categoryAt: samples.length ? (at) => categoryNear(samples, at.getTime()) : () => null,
  });

  const cursor = db
    .collection("messages")
    .find({ channel, timestamp: { $gte: start, $lt: end } })
    .project({ _id: 0, userId: 1, userName: 1, message: 1, timestamp: 1, gifs: 1 })
    .sort({ timestamp: 1 })
    .batchSize(5000);
  for await (const doc of cursor) acc.add(doc);
  const state = acc.finish();
  const scanMs = Date.now() - t0;

  // Loud minutes: the second read is per moment and indexed, five small reads in all.
  const loud = [];
  for (const moment of recap.pickLoudMoments(state.minutes)) {
    const lines = await db
      .collection("messages")
      .find({ channel, timestamp: { $gte: new Date(moment.at), $lt: new Date(moment.at + 60000) } })
      .project({ _id: 0, message: 1 })
      .limit(3000)
      .toArray();
    loud.push({
      at: new Date(moment.at),
      n: moment.n,
      category: categoryNear(samples, moment.at),
      chant: recap.chantOf(lines.map((l) => l.message)),
    });
  }

  // Hours on air per category, from the gaps between samples (capped, so an outage between two
  // samples is not counted as hours of streaming).
  const categoryHours = new Map();
  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1];
    const span = next ? Math.min(next.t - samples[i].t, CATEGORY_MAX_GAP_MS) : 5 * 60 * 1000;
    const c = samples[i].category || null;
    if (!c) continue;
    categoryHours.set(c, (categoryHours.get(c) || 0) + span);
  }
  const categories = [...categoryHours.entries()]
    .map(([name, ms]) => {
      const hours = ms / 3600000;
      const messages = state.categories.get(name) || 0;
      return { name, hours, messages, perHour: hours ? messages / hours : 0 };
    })
    .filter((c) => c.hours >= 1)
    .sort((a, b) => b.hours - a.hours);

  // Moderation, unbans and the bot's answers - each with the date its data starts, because none of
  // the three covers the whole year (see планы/рекап-года.md).
  const [modRows, unbanRows, aiCount, aiAskers] = await Promise.all([
    db
      .collection("ModeratorActionLogs")
      .find({ channel: login, timestamp: { $gte: start, $lt: end } })
      .project({ _id: 0, action: 1, reason: 1, modID: 1, TTA: 1, timestamp: 1 })
      .toArray(),
    db
      .collection("UnbanRequests")
      .find({ channelId, "resolution.decidedAt": { $gte: start, $lt: end } })
      .project({ _id: 0, twitchStatus: 1 })
      .toArray(),
    db.collection("AiReplyLog").countDocuments({ channel, sent: true, createdAt: { $gte: start, $lt: end } }),
    db
      .collection("AiReplyLog")
      .aggregate([
        { $match: { channel, sent: true, createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: "$userId", login: { $last: "$login" }, n: { $sum: 1 }, first: { $min: "$createdAt" } } },
        { $sort: { n: -1 } },
        { $limit: 15 },
      ])
      .toArray(),
  ]);
  const aiFirst = aiCount
    ? (
        await db
          .collection("AiReplyLog")
          .find({ channel, createdAt: { $gte: start, $lt: end } })
          .project({ createdAt: 1 })
          .sort({ createdAt: 1 })
          .limit(1)
          .toArray()
      )[0]?.createdAt || null
    : null;

  const moderation = { actions: {}, duel: 0, sniper: 0, self: 0, since: null, fastest: [] };
  const ttaByMod = new Map();
  for (const row of modRows) {
    if (!moderation.since || row.timestamp < moderation.since) moderation.since = row.timestamp;
    moderation.actions[row.action] = (moderation.actions[row.action] || 0) + 1;
    const kind = reasonKind(row.reason);
    if (kind) {
      moderation[kind] += 1;
      continue; // a duel or a sniper shot is not a moderator reacting to anything
    }
    if (typeof row.TTA === "number" && row.TTA > 0 && row.modID) {
      const id = String(row.modID);
      if (!ttaByMod.has(id)) ttaByMod.set(id, []);
      ttaByMod.get(id).push(row.TTA);
    }
  }
  moderation.fastest = [...ttaByMod.entries()]
    .filter(([, v]) => v.length >= MOD_MIN_ACTIONS)
    .map(([userId, v]) => ({ userId, medianMs: median(v), actions: v.length }))
    .sort((a, b) => a.medianMs - b.medianMs)
    .slice(0, 10);

  const unbans = { approved: 0, denied: 0 };
  for (const r of unbanRows) if (r.twitchStatus in unbans) unbans[r.twitchStatus] += 1;

  // Who-to-whom, stored apart for the personal page.
  const mentionRows = [];
  for (const [key, n] of state.mentions) {
    if (n < MENTION_MIN_STORED) continue;
    const [from, to] = key.split("\u0000");
    mentionRows.push({ from, to, n });
  }

  const idByLogin = new Map();
  for (const [userId, u] of state.users) if (u.name) idByLogin.set(u.name, userId);

  const firstChatters = {};
  for (const s of state.sessions) {
    if (s.firstUserId) firstChatters[s.firstUserId] = (firstChatters[s.firstUserId] || 0) + 1;
  }

  const topChatters = [...state.users.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, TOP_LIST)
    .map(([userId, u]) => ({ userId, name: u.name, n: u.n }));

  const pairs = recap.topMutualPairs(state.mentions, { limit: TOP_LIST }).map((p) => ({
    ...p,
    aId: idByLogin.get(p.a) || null,
    bId: idByLogin.get(p.b) || null,
  }));

  const firstWords = newWordRows
    .map((w) => {
      const first = state.firstUse.get(w._id);
      return { word: w._id, n: w.n, firstAt: w.first, by: first || null };
    })
    .slice(0, 20);

  const [wordCurves, emoteCurves] = await Promise.all([
    monthlyCurves(db, "ChatWordStats", channel, words.top.slice(0, 5).map((w) => w.word), start, end),
    monthlyCurves(db, "words", channel, emotes.top.slice(0, 5).map((w) => w.word), start, end),
  ]);

  const data = {
    version: 1,
    range: { start, end },
    totals: {
      messages: state.total,
      chatters: state.users.size,
      streams: state.sessions.length,
      wordUses: words.total,
      emoteUses: emotes.total,
    },
    months: state.months,
    hours: state.hours,
    topChatters,
    sortedCounts: recap.sortedCounts(state.users),
    words: { top: words.top, curves: wordCurves },
    emotes: { top: emotes.top, curves: emoteCurves },
    newWords: firstWords,
    loud,
    categories: { since: samples.length ? new Date(samples[0].t) : null, list: categories.slice(0, 15) },
    pairs,
    commands: recap.topCommands(state.commands),
    sessions: state.sessions.map((s) => ({
      start: s.start,
      end: s.end,
      messages: s.messages,
      firstUserId: s.firstUserId,
    })),
    firstChatters,
    moderation,
    unbans,
    ai: { answers: aiCount, since: aiFirst, askers: aiAskers.map((a) => ({ userId: a._id, name: a.login, n: a.n })) },
    buildMs: { scan: scanMs, total: Date.now() - t0 },
  };

  await recapRepo.replaceMentions(login, year, mentionRows);
  const saved = await recapRepo.saveChannelRecap(login, year, data);
  await recapRepo.clearUserRecaps(login, year);
  console.log(
    `[annualRecap] ${login} ${year}: ${state.total} messages, ${state.users.size} chatters, ` +
      `${state.sessions.length} streams, ${mentionRows.length} mention rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  return saved;
}

// One build per channel at a time: two concurrent builds of the same recap would race on the
// mentions collection (each deletes the other's rows).
const running = new Map();

function startBuild(channelLogin, year) {
  const key = `${String(channelLogin).toLowerCase()}:${year}`;
  if (running.has(key)) return { started: false, promise: running.get(key) };
  const promise = buildChannelRecap(channelLogin, year).finally(() => running.delete(key));
  running.set(key, promise);
  return { started: true, promise };
}

function isBuilding(channelLogin, year) {
  return running.has(`${String(channelLogin).toLowerCase()}:${year}`);
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REBUILD_AFTER_MS = 20 * 60 * 60 * 1000;

function startAnnualRecapLoop() {
  async function sweep() {
    let channels = [];
    try {
      channels = (await channelsRepo.listAll()).filter((c) => c.recapEnabled);
    } catch (err) {
      console.error("[annualRecap] channel list failed:", err.message);
      return;
    }
    const year = recap.currentYear();
    for (const ch of channels) {
      // The current year, daily; last year once more if its last build predates its end.
      for (const y of [year - 1, year]) {
        try {
          const doc = await recapRepo.getChannelRecap(ch.channelLogin, y);
          const { end } = recap.yearRange(y);
          const due =
            y === year
              ? !doc || Date.now() - doc.builtAt.getTime() > REBUILD_AFTER_MS
              : doc && doc.builtAt < end;
          if (!due || isBuilding(ch.channelLogin, y)) continue;
          await startBuild(ch.channelLogin, y).promise;
        } catch (err) {
          console.error(`[annualRecap] ${ch.channelLogin} ${y} failed:`, err.message);
        }
      }
    }
  }
  setTimeout(sweep, 60 * 1000);
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

module.exports = { buildChannelRecap, startBuild, isBuilding, startAnnualRecapLoop, categoryNear };
