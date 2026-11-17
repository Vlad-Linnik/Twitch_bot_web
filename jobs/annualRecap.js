// Builds a channel's annual recap (/:channel/recap) into AnnualRecaps - see db/annualRecapRepo.js
// for the storage and lib/annualRecap.js for what every number means.
//
// ONE time-ordered pass over the year's `messages` fills everything that needs the raw text or the
// author (sessions, hours, who @-ed whom, commands, the first author of a new word),
// plus aggregations over the daily rows for what is already counted (words, emotes). It is the same
// shape of work as jobs/higherLowerExamples.js, which reads ~2M messages in about twenty seconds.
//
// Runs from the admin panel's button, and once a day for every channel whose recap section is
// switched on: the current year keeps growing until it ends, and a finished year gets one last
// build after its final day.
const { connect, connectWeb } = require("../db/connection");
const channelsRepo = require("../db/channelsRepo");
const recapRepo = require("../db/annualRecapRepo");
const { emotePredicate } = require("../db/emotePredicate");
const { KNOWN_BOT_LOGINS } = require("../config/knownBots");
const { getKnownBotIdentifiers } = require("../lib/knownBotIds");
const { clipsInWindow, videoStarts } = require("../twitch/clips");
const emoteImages = require("../twitch/emoteImages");
const { LIFETIME_BUCKET } = require("../lib/textStats");
const recap = require("../lib/annualRecap");

const withHash = (login) => `#${String(login).toLowerCase().replace(/^#/, "")}`;

// A viewer sample further than this from a message says nothing about what was on screen.
const CATEGORY_MAX_GAP_MS = 10 * 60 * 1000;
// A word needs this many uses in the year (all its forms together) to be a "new word of the year".
const NEW_WORD_MIN_USES = 30;
// A single spelling below this is too rare to fetch as a candidate form; the forms that carry a
// word are well above it.
const NEW_WORD_FORM_MIN_USES = 5;
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

// Every word form the channel said at least twice this year, with its count. Twice and not the
// five the "your word" rule asks of a person: that rule compares FORMS summed into one word, and a
// person's form can be one use of a word they said five times in total. With the floor at two, a
// form missing from this list was said exactly once in the channel - and the person asking said
// it, so that once is theirs - which keeps the personal comparison exact
// (db/annualRecapUserService.js). Runs on the {channel, date, count, word} index alone.
async function channelWordCounts(db, channel, start, end) {
  const rows = await db
    .collection("ChatWordStats")
    .aggregate(
      [
        { $match: { channel, date: { $gte: start, $lt: end } } },
        { $group: { _id: "$word", n: { $sum: "$count" } } },
        { $match: { n: { $gte: 2 } } },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  return rows.map((r) => ({ word: r._id, n: r.n }));
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


// Words the chat started saying this year, grouped by form (lib/annualRecap.js's groupWordForms).
// "New" is decided per WORD, not per spelling: «дипе» first appearing this year means nothing if
// «дип» was said all last year. So the candidates are new spellings, grouped, and then each group's
// stem is looked up in the history before the year - an anchored prefix match on the {channel,
// word, date} index, confirmed by stemming whatever it finds.
async function newWordCandidates(db, channel, start, end, isEmote) {
  const earliest = await db
    .collection("ChatWordStats")
    .find({ channel, date: { $gt: LIFETIME_BUCKET } })
    .project({ date: 1 })
    .sort({ date: 1 })
    .limit(1)
    .toArray();
  if (!earliest.length || start.getTime() - earliest[0].date.getTime() < NEW_WORD_MIN_HISTORY_MS) return [];
  const forms = await db
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
        { $match: { first: { $gte: start }, n: { $gte: NEW_WORD_FORM_MIN_USES } } },
        { $sort: { n: -1 } },
        { $limit: 2000 },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  const firstOf = new Map(forms.map((f) => [f._id, f.first]));
  const groups = recap
    .groupWordForms(forms.filter((f) => !isEmote(f._id)).map((f) => ({ word: f._id, n: f.n })))
    .filter((g) => g.n >= NEW_WORD_MIN_USES)
    .slice(0, 60);

  const out = [];
  for (const g of groups) {
    if (/[а-яё]/.test(g.key)) {
      const older = await db
        .collection("ChatWordStats")
        .aggregate([
          {
            $match: {
              channel,
              word: { $regex: "^" + recap.escapeRegExp(g.key) },
              date: { $gt: LIFETIME_BUCKET, $lt: start },
            },
          },
          { $group: { _id: "$word" } },
          { $limit: 3000 },
        ])
        .toArray();
      if (older.some((o) => recap.formKey(o._id) === g.key)) continue;
    }
    const first = g.forms.reduce((min, f) => (firstOf.get(f) < min ? firstOf.get(f) : min), firstOf.get(g.forms[0]));
    out.push({ word: g.word, forms: g.forms, n: g.n, first });
    if (out.length >= 25) break;
  }
  return out;
}

// The year's loud minutes that a viewer clipped. Each candidate minute costs one small indexed
// read of its messages (the chant) and one Get Clips call; a minute nobody clipped is dropped -
// the recap shows the moment as video or not at all.
//
// A Helix failure must not wipe moments a previous build found: the clips are a lookup of
// something that does not change, so on error the previous build's list is kept.
// The year's most watched clips of the channel - "clip of the year" decided by views, with no vote:
// Helix answers a created_at window already sorted by view count, so the first page is the top.
// The view counts are as of the build; the daily rebuild keeps them current through the year.
// Fail-soft like the moments: an outage keeps the previous build's list.
const TOP_CLIPS = 5;

function shapeClip(c) {
  return {
    id: c.id,
    url: c.url,
    thumbnailUrl: c.thumbnail_url,
    title: c.title,
    creator: c.creator_name,
    views: c.view_count,
    duration: c.duration,
    createdAt: c.created_at,
  };
}

// Each clip also carries what the chat was shouting while it happened (lib/annualRecap.js's
// clipChatWindow + chantOf) - one small indexed read of messages per clip.
async function topClipsOfYear(db, channel, channelId, start, end, login, year) {
  try {
    const clips = (await clipsInWindow(channelId, start, end))
      .slice()
      .sort((a, b) => b.view_count - a.view_count)
      .slice(0, TOP_CLIPS);
    const starts = await videoStarts(clips.filter((c) => c.video_id && c.vod_offset !== null).map((c) => c.video_id));
    const out = [];
    for (const c of clips) {
      const win = recap.clipChatWindow(c, starts.get(String(c.video_id)) || null);
      const lines = await db
        .collection("messages")
        .find({ channel, timestamp: { $gte: win.from, $lt: win.to } })
        .project({ _id: 0, message: 1 })
        .limit(3000)
        .toArray();
      out.push({ ...shapeClip(c), chant: recap.chantOf(lines.map((l) => l.message), { minRepeats: recap.CLIP_CHANT_MIN_REPEATS }) });
    }
    return out;
  } catch (err) {
    console.error(`[annualRecap] ${login} ${year}: top clips lookup failed, keeping the previous list:`, err.message);
    const previous = await recapRepo.getChannelRecap(login, year).catch(() => null);
    return previous?.data?.topClips || [];
  }
}

async function loudMomentsWithClips(db, channel, channelId, minutes, samples, login, year) {
  const candidates = recap.pickLoudMoments(minutes);
  const out = [];
  try {
    for (const moment of candidates) {
      const { from, to } = recap.clipWindow(moment.at);
      const clips = await clipsInWindow(channelId, from, to);
      const starts = await videoStarts(clips.filter((c) => c.video_id && c.vod_offset !== null).map((c) => c.video_id));
      const clip = recap.pickClipForMoment(clips, moment.at, starts);
      if (!clip) continue;
      const lines = await db
        .collection("messages")
        .find({ channel, timestamp: { $gte: new Date(moment.at), $lt: new Date(moment.at + 60000) } })
        .project({ _id: 0, message: 1 })
        .limit(3000)
        .toArray();
      out.push({
        at: new Date(moment.at),
        n: moment.n,
        category: categoryNear(samples, moment.at),
        chant: recap.chantOf(lines.map((l) => l.message)),
        clip: shapeClip(clip),
      });
    }
    return out;
  } catch (err) {
    console.error(`[annualRecap] ${login} ${year}: clip lookup failed, keeping the previous moments:`, err.message);
    const previous = await recapRepo.getChannelRecap(login, year).catch(() => null);
    return previous?.data?.loud || out;
  }
}

// Hours each moderator spent on the channel's streams this year, from the bot's daily
// ModUpTimeStats rows (channelId is a string, except a few legacy rows written as a number). The
// broadcaster is there whenever there is a stream, which is not what this top is about.
async function modPresence(db, channelId, start, end, botMods) {
  const rows = await db
    .collection("ModUpTimeStats")
    .aggregate([
      { $match: { channelId: { $in: [channelId, Number(channelId)] }, timestamp: { $gte: start, $lt: end } } },
      { $group: { _id: "$userId", hours: { $sum: "$hours" }, days: { $sum: 1 } } },
      { $sort: { hours: -1 } },
      { $limit: 15 },
    ])
    .toArray();
  return rows
    .filter((r) => String(r._id) !== String(channelId) && !botMods.has(String(r._id).toLowerCase()))
    .slice(0, 10)
    .map((r) => ({ userId: String(r._id), hours: r.hours, days: r.days }));
}

// The best results in the site's own games, among people who wrote in this chat this year. A score
// counts for the year it was set (achievedAt); per-channel game variants of another channel
// (higher-lower-words-<other>) are left out. Higher is better in every game, Durak's rating too.
const SITE_GAMES_TOP = 3;
async function siteGameTops(users, login, start, end) {
  const web = await connectWeb();
  const rows = await web
    .collection("GameScores")
    .find({ achievedAt: { $gte: start, $lt: end } })
    .project({ _id: 0, game: 1, userId: 1, bestScore: 1, achievedAt: 1 })
    .toArray();
  const byGame = new Map();
  for (const r of rows) {
    const game = String(r.game);
    const variant = /^(higher-lower-(?:words|emotes)|guess-chatter)-(.+)$/.exec(game);
    if (variant && variant[2] !== login) continue;
    const user = users.get(String(r.userId));
    if (!user) continue;
    if (!byGame.has(game)) byGame.set(game, []);
    byGame.get(game).push({ userId: String(r.userId), name: user.name, score: r.bestScore, at: r.achievedAt });
  }
  return [...byGame.entries()]
    .map(([game, list]) => ({
      game,
      players: list.length,
      top: list.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, SITE_GAMES_TOP),
    }))
    .sort((a, b) => b.players - a.players);
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

  // The emote registry (whiteList & co) is the bot's view, and it can lag: a channel emote the
  // sync has not caught yet is a "word" to it - McopMeeting showed up as a word the chat invented
  // on a copy of the database taken before the 7TV sync knew it. The same names the page draws as
  // pictures (twitch/emoteImages.js, live from the providers) are added, so a token the page
  // itself renders as an emote is never listed as a word.
  const registryEmote = await emotePredicate(db, channel);
  const pictured = await emoteImages
    .getEmoteImageMap(channelId, login, { complete: true })
    .then((map) => new Set([...map.keys()].map((n) => String(n).toLowerCase())))
    .catch(() => new Set());
  const isEmote = (token) => registryEmote(token) || pictured.has(String(token).toLowerCase());
  const [words, emotes, newWords, samplesRaw, customCommands] = await Promise.all([
    topAndTotal(db, "ChatWordStats", channel, start, end, 200),
    topAndTotal(db, "words", channel, start, end, 40),
    newWordCandidates(db, channel, start, end, isEmote),
    db
      .collection("StreamViewerSamples")
      .find({ channelId, timestamp: { $gte: start, $lt: end } })
      .project({ _id: 0, timestamp: 1, category: 1, viewerCount: 1 })
      .sort({ timestamp: 1 })
      .toArray(),
    db.collection("custom_commands").find({ channel }).project({ _id: 0, command: 1, aliases: 1 }).toArray(),
  ]);
  const commandAliases = recap.commandAliasMap(customCommands);
  // ChatWordStats still holds rows for tokens learnt to be emotes after they were counted (see
  // CLAUDE.md "Words vs emotes"); the same predicate the word cloud uses keeps them out of the word
  // lists, where an emote is not a word and certainly not one the chat invented.
  words.top = recap.groupWordForms(words.top.filter((w) => !isEmote(w.word))).slice(0, 60);

  const samples = samplesRaw.map((s) => ({ t: s.timestamp.getTime(), category: s.category, viewers: s.viewerCount }));

  const acc = recap.createChannelAccumulator({
    isEmote,
    botLogins,
    candidateWords: new Set(newWords.flatMap((w) => w.forms)),
    broadcasterLogin: login,
    commandAliases,
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

  const loud = await loudMomentsWithClips(db, channel, channelId, state.minutes, samples, login, year);
  const topClips = await topClipsOfYear(db, channel, channelId, start, end, login, year);

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

  // Moderation and unbans - each with the date its data starts, because neither covers the whole
  // year (see планы/рекап-года.md).
  const [modRows, unbanRows] = await Promise.all([
    db
      .collection("ModeratorActionLogs")
      .find({ channel: login, timestamp: { $gte: start, $lt: end } })
      .project({ _id: 0, action: 1, reason: 1, modID: 1, TTA: 1, timestamp: 1, durationMs: 1 })
      .toArray(),
    db
      .collection("UnbanRequests")
      .find({ channelId, "resolution.decidedAt": { $gte: start, $lt: end } })
      .project({ _id: 0, twitchStatus: 1 })
      .toArray(),
  ]);

  const moderation = { actions: {}, duel: 0, sniper: 0, self: 0, since: null, fastest: [], mostActions: [], longestGiven: [], presence: [] };
  const ttaByMod = new Map();
  const tallyByMod = new Map(); // modID -> { bans, timeouts, deletes, timeoutMs }
  // Bots hold moderator rights and answer in milliseconds, so they would top "fastest moderators"
  // every time. modID is an id (or a login on legacy rows), hence both spellings.
  const bots = await getKnownBotIdentifiers();
  const botMods = new Set([...bots.ids, ...bots.logins].map(String));
  for (const row of modRows) {
    if (!moderation.since || row.timestamp < moderation.since) moderation.since = row.timestamp;
    const kind = reasonKind(row.reason);
    if (kind) {
      moderation[kind] += 1;
      continue; // a duel or a sniper shot is not a moderator reacting to anything
    }
    moderation.actions[row.action] = (moderation.actions[row.action] || 0) + 1;
    if (row.modID && !botMods.has(String(row.modID).toLowerCase())) {
      const id = String(row.modID);
      let t = tallyByMod.get(id);
      if (!t) tallyByMod.set(id, (t = { bans: 0, timeouts: 0, deletes: 0, timeoutMs: 0 }));
      if (row.action === "ban") t.bans += 1;
      else if (row.action === "timeout") {
        t.timeouts += 1;
        t.timeoutMs += Number(row.durationMs) || 0;
      } else if (row.action === "delete") t.deletes += 1;
    }
    if (typeof row.TTA === "number" && row.TTA > 0 && row.modID && !botMods.has(String(row.modID).toLowerCase())) {
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

  // Three more tops of the moderators, each answering its own question: who acted most (bans and
  // timeouts), who gave the most time in timeouts (a ban has no length and is left out of that one),
  // and who was there longest (ModUpTimeStats - hours present on stream, the bot's own reading).
  const tallies = [...tallyByMod.entries()].map(([userId, t]) => ({ userId, ...t }));
  moderation.mostActions = tallies
    .filter((t) => t.bans + t.timeouts > 0)
    .sort((a, b) => b.bans + b.timeouts - (a.bans + a.timeouts))
    .slice(0, 10)
    .map((t) => ({ userId: t.userId, bans: t.bans, timeouts: t.timeouts }));
  moderation.longestGiven = tallies
    .filter((t) => t.timeoutMs > 0)
    .sort((a, b) => b.timeoutMs - a.timeoutMs)
    .slice(0, 10)
    .map((t) => ({ userId: t.userId, timeoutMs: t.timeoutMs, timeouts: t.timeouts }));
  moderation.presence = await modPresence(db, channelId, start, end, botMods);

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

  // The first author of a word is whoever wrote ANY of its forms first.
  const firstWords = newWords
    .map((w) => {
      const by = w.forms
        .map((f) => state.firstUse.get(f))
        .filter(Boolean)
        .sort((a, b) => a.at - b.at)[0];
      return { word: w.word, forms: w.forms, n: w.n, firstAt: w.first, by: by || null };
    })
    .slice(0, 20);

  // The channel's word counts for the personal page (db/annualRecapRepo.js's
  // AnnualRecapWordCounts). Written before the recap that names them, pruned after it is saved.
  const wordCountsAt = new Date();
  await recapRepo.insertWordCounts(login, year, wordCountsAt, await channelWordCounts(db, channel, start, end));

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
    words: { top: words.top },
    emotes: { top: emotes.top },
    newWords: firstWords,
    loud,
    topClips,
    categories: { since: samples.length ? new Date(samples[0].t) : null, list: categories.slice(0, 15) },
    pairs,
    commands: recap.topCommands(state.commands, 15, commandAliases),
    sessions: state.sessions.map((s) => ({
      start: s.start,
      end: s.end,
      messages: s.messages,
      firstUserId: s.firstUserId,
    })),
    firstChatters,
    moderation,
    unbans,
    siteGames: await siteGameTops(state.users, login, start, end).catch((err) => {
      console.error(`[annualRecap] ${login} ${year}: site game tops failed:`, err.message);
      return [];
    }),
    wordCountsAt,
    buildMs: { scan: scanMs, total: Date.now() - t0 },
  };

  await recapRepo.replaceMentions(login, year, mentionRows);
  const saved = await recapRepo.saveChannelRecap(login, year, data);
  await recapRepo.pruneWordCounts(login, year, wordCountsAt);
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
