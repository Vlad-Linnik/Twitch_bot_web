// The personal annual recap (/:channel/recap/:year/me): one viewer's year in one channel, built on
// first view and cached until the channel recap is rebuilt (db/annualRecapRepo.js).
//
// Built on demand rather than by the channel job because it needs every word of the person's own
// messages: 20k chatters' word tables at once would not fit in the process, while one person's is
// a single indexed read ({channel, userId, timestamp}) - tens of milliseconds even for the most
// active chatter of the year.
//
// The punishment half (timeouts, duels, the sniper, the Bureau's verdict) exists ONLY here, and
// only the person themselves can open this page; the public recap shows sums.
const { connect } = require("./connection");
const recapRepo = require("./annualRecapRepo");
const { emotePredicate } = require("./emotePredicate");
const { extractWords, extractMentions } = require("../lib/textStats");
const { KNOWN_BOT_LOGINS } = require("../config/knownBots");
const recap = require("../lib/annualRecap");
const { reasonKind } = recap;

const withHash = (login) => `#${String(login).toLowerCase().replace(/^#/, "")}`;

// The person's own words the comparison is asked about. Their top N by use is where "your word"
// can be; the rest are words said a handful of times.
const WORD_CANDIDATES = 150;

async function computeUserRecap(channelDoc, year, userId, channelRecap) {
  const db = await connect();
  const login = channelDoc.channelLogin;
  const channel = withHash(login);
  const channelId = String(channelDoc.channelId);
  const { start, end } = recap.yearRange(year);
  const bots = new Set(KNOWN_BOT_LOGINS.map((l) => l.toLowerCase()));

  const isEmote = await emotePredicate(db, channel);
  const docs = await db
    .collection("messages")
    .find({ channel, userId: String(userId), timestamp: { $gte: start, $lt: end } })
    .project({ _id: 0, message: 1, timestamp: 1, userName: 1, gifs: 1 })
    .sort({ timestamp: 1 })
    .toArray();

  if (docs.length === 0) return { empty: true };

  const names = new Set();
  const months = new Array(12).fill(0);
  const hours = new Array(24).fill(0);
  const wordCounts = new Map();
  const emoteCounts = new Map();
  const outMentions = new Map();
  let wordTotal = 0;

  for (const d of docs) {
    const name = String(d.userName || "").toLowerCase();
    if (name) names.add(name);
    const { month, hour } = recap.localParts(d.timestamp);
    months[month] += 1;
    hours[hour] += 1;
    if (d.gifs && d.gifs.length) continue;
    for (const w of extractWords(d.message, isEmote)) {
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      wordTotal += 1;
    }
    for (const e of recap.emotesIn(d.message, isEmote)) emoteCounts.set(e, (emoteCounts.get(e) || 0) + 1);
    for (const target of extractMentions(d.message, [...names])) {
      if (bots.has(target)) continue;
      outMentions.set(target, (outMentions.get(target) || 0) + 1);
    }
  }

  // Channel-side counts for the person's most used words only.
  // One word, many spellings: «табакошка» and «табакошку» are counted together on both sides of
  // the comparison (lib/annualRecap.js's groupWordForms).
  const groups = recap
    .groupWordForms([...wordCounts.entries()].map(([word, n]) => ({ word, n })))
    .slice(0, WORD_CANDIDATES);
  const candidates = groups.map((g) => [g.word, g.n]);
  const channelCounts = new Map();
  if (groups.length) {
    const labelOf = new Map(groups.flatMap((g) => g.forms.map((form) => [form, g.word])));
    const forms = [...labelOf.keys()];
    let formCounts;
    const at = channelRecap.data.wordCountsAt;
    if (at) {
      // The counts the channel job stored (db/annualRecapRepo.js's AnnualRecapWordCounts): a
      // covered index read instead of every day row of these words. A form not stored was said
      // once in the channel, and this person said it - see jobs/annualRecap.js's
      // channelWordCounts - so its count is theirs, i.e. 1.
      const stored = await recapRepo.wordCountsOf(login, year, at, forms);
      formCounts = forms.map((form) => [form, stored.get(form) ?? wordCounts.get(form) ?? 0]);
    } else {
      // A recap built before those counts existed, until its next rebuild.
      const rows = await db
        .collection("ChatWordStats")
        .aggregate([
          { $match: { channel, word: { $in: forms }, date: { $gte: start, $lt: end } } },
          { $group: { _id: "$word", n: { $sum: "$count" } } },
        ])
        .toArray();
      formCounts = rows.map((r) => [r._id, r.n]);
    }
    for (const [form, n] of formCounts) {
      const label = labelOf.get(form);
      channelCounts.set(label, (channelCounts.get(label) || 0) + n);
    }
  }
  const yourWords = recap.distinctiveWords(
    new Map(candidates),
    wordTotal,
    channelCounts,
    channelRecap.data.totals.wordUses
  );

  const nameList = [...names];
  const inRows = await recapRepo.mentionsOf(login, year, nameList);
  const partnerScore = new Map();
  for (const [to, n] of outMentions) {
    const p = partnerScore.get(to) || { login: to, out: 0, in: 0 };
    p.out += n;
    partnerScore.set(to, p);
  }
  for (const r of inRows) {
    if (names.has(r.from) || bots.has(r.from)) continue;
    const p = partnerScore.get(r.from) || { login: r.from, out: 0, in: 0 };
    p.in += r.n;
    partnerScore.set(r.from, p);
  }
  // The streamer is everyone's most-mentioned person; "you talked most with the streamer" would be
  // the answer for most of the chat and says nothing about anyone.
  const broadcaster = String(login).toLowerCase();
  const partners = [...partnerScore.values()]
    .filter((p) => !names.has(p.login) && p.login !== broadcaster)
    .sort((a, b) => b.out + b.in - (a.out + a.in))
    .slice(0, 3);

  const timestamps = docs.map((d) => d.timestamp);
  const attendance = recap.attendanceOf(channelRecap.data.sessions, timestamps, String(userId));
  const standing = recap.standingOf(channelRecap.data.sortedCounts, docs.length);

  const [modRows, unbanRows] = await Promise.all([
    db
      .collection("ModeratorActionLogs")
      .find({ channel: login, userId: String(userId), timestamp: { $gte: start, $lt: end } })
      .project({ _id: 0, action: 1, reason: 1 })
      .toArray(),
    db
      .collection("UnbanRequests")
      .find({ channelId, userId: String(userId), "resolution.decidedAt": { $gte: start, $lt: end } })
      .project({ _id: 0, twitchStatus: 1 })
      .toArray(),
  ]);

  const punishments = { timeouts: 0, bans: 0, deletes: 0, duel: 0, sniper: 0, self: 0 };
  for (const r of modRows) {
    const kind = reasonKind(r.reason);
    if (kind) punishments[kind] += 1;
    else if (r.action === "timeout") punishments.timeouts += 1;
    else if (r.action === "ban") punishments.bans += 1;
    else if (r.action === "delete") punishments.deletes += 1;
  }
  const amnesty = { approved: 0, denied: 0 };
  for (const r of unbanRows) if (r.twitchStatus in amnesty) amnesty[r.twitchStatus] += 1;

  const first = docs[0];
  const longest = docs.reduce((best, d) => {
    const len = String(d.message || "").length;
    return len > best.len ? { len, d } : best;
  }, { len: 0, d: null });

  return {
    empty: false,
    name: String(docs[docs.length - 1].userName || ""),
    messages: docs.length,
    months,
    hours,
    chronotype: recap.chronotypeOf(hours),
    standing,
    firstMessage: { at: first.timestamp, text: String(first.message || "").slice(0, 300) },
    longestMessage: longest.d ? { at: longest.d.timestamp, length: longest.len } : null,
    activeDays: new Set(docs.map((d) => {
      const p = recap.localParts(d.timestamp);
      return `${p.month}-${p.day}`;
    })).size,
    attendance,
    words: yourWords,
    topWords: candidates.slice(0, 5).map(([word, n]) => ({ word, n })),
    emotes: [...emoteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n })),
    partners,
    punishments,
    amnesty,
  };
}

// Cached read: rebuilt only when the channel recap it was computed against has changed.
async function getUserRecap(channelDoc, year, userId, channelRecap) {
  const basedOn = channelRecap.builtAt;
  const cached = await recapRepo.getUserRecap(channelDoc.channelLogin, year, userId);
  if (cached && cached.basedOn && cached.basedOn.getTime() === basedOn.getTime()) return cached.data;
  const data = await computeUserRecap(channelDoc, year, userId, channelRecap);
  await recapRepo.saveUserRecap(channelDoc.channelLogin, year, userId, basedOn, data);
  return data;
}

// Map<login, userId> for the logins a recap names by login only (the people someone @-mentioned).
// Logins change, so the nickname history is searched too; a login nobody has had is left out.
async function userIdsByLogin(logins) {
  const wanted = [...new Set(logins.filter(Boolean).map((l) => String(l).toLowerCase()))];
  if (!wanted.length) return new Map();
  const db = await connect();
  const rows = await db
    .collection("UserIdentities")
    .find({ $or: [{ currentUserName: { $in: wanted } }, { "nicknames.name": { $in: wanted } }] })
    .project({ _id: 0, userId: 1, currentUserName: 1, "nicknames.name": 1 })
    .toArray();
  const out = new Map();
  // A current name wins over an old one: the login someone holds today is theirs.
  for (const r of rows) if (wanted.includes(r.currentUserName)) out.set(r.currentUserName, String(r.userId));
  for (const r of rows) {
    for (const n of r.nicknames || []) if (wanted.includes(n.name) && !out.has(n.name)) out.set(n.name, String(r.userId));
  }
  return out;
}

module.exports = { getUserRecap, computeUserRecap, userIdsByLogin };
