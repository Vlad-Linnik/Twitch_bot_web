// The annual recap's arithmetic: everything that decides WHAT the recap says, kept free of Mongo
// so it can be tested. jobs/annualRecap.js feeds it the channel's messages in time order;
// db/annualRecapUserService.js feeds it one viewer's.
//
// The recap is about the chat, not about watching: Twitch's own recap already tells a viewer how
// many hours they watched, and that is the one thing we cannot measure. What only this bot sees is
// who talked to whom, which words the chat invented, and the minutes the chat shouted.
const { extractWords, extractMentions } = require("./textStats");

// The audience's clock. Moscow has had no daylight-saving change since 2014, so a fixed offset is
// exact, and it is a property of the channel's audience rather than of the server: a "night owl"
// computed in the VPS's UTC would be three hours off for everyone.
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

// A pause in chat longer than this ends a stream. Derived from chat rather than taken from
// StreamSessions because that collection only starts on 2026-07-24, and the recap covers the whole
// year; a short break (a game loading, a smoke) stays inside one stream.
const SESSION_GAP_MS = 90 * 60 * 1000;
// Fewer messages than this is chat talking between streams, not a stream.
const SESSION_MIN_MESSAGES = 300;

const LOUD_MOMENTS = 5;
// Two peaks closer than this are the same moment of the same stream.
const LOUD_SEPARATION_MS = 30 * 60 * 1000;

const COMMAND_MAX_LENGTH = 25;

function yearRange(year) {
  const start = new Date(Date.UTC(year, 0, 1) - TZ_OFFSET_MS);
  const end = new Date(Date.UTC(year + 1, 0, 1) - TZ_OFFSET_MS);
  return { start, end };
}

function localParts(date) {
  const d = new Date(new Date(date).getTime() + TZ_OFFSET_MS);
  return { month: d.getUTCMonth(), hour: d.getUTCHours(), day: d.getUTCDate() };
}

// The year it is now on the audience's clock - the one the daily rebuild keeps current.
function currentYear(now = new Date()) {
  return new Date(new Date(now).getTime() + TZ_OFFSET_MS).getUTCFullYear();
}

function commandOf(message) {
  const m = /^\s*!([^\s!]+)/.exec(String(message || ""));
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[^\p{L}\p{N}_-]+$/u, "");
  if (!name || name.length > COMMAND_MAX_LENGTH) return null;
  return name;
}

// The bot's own timeout reasons (TwitchBot: the duel, the Bureau's AWP and its shrapnel, a mute
// asked for by the viewer). They are written by code, so matching them by text is matching a
// constant - and none of them is a moderator reacting to anything.
const DUEL_REASONS = new Set(["duel", "дуэль по собственному"]);
const SNIPER_PREFIXES = ["Шальная пуля", "Осколки"];
const SELF_REASONS = new Set(["по собственной просьбе"]);

function reasonKind(reason) {
  const r = String(reason || "");
  if (DUEL_REASONS.has(r)) return "duel";
  if (SNIPER_PREFIXES.some((p) => r.startsWith(p))) return "sniper";
  if (SELF_REASONS.has(r)) return "self";
  return null;
}

// Accumulates the whole channel's year in one pass. Messages MUST arrive in time order (sessions
// and "who wrote this word first" both depend on it).
//
// options.isEmote      - the channel's emote predicate (db/emotePredicate.js)
// options.botLogins    - lowercased logins never counted (bots talk a lot and are not chat)
// options.candidateWords - words whose first author this year is wanted ("patient zero")
// options.categoryAt   - (Date) => category name or null
// options.broadcasterLogin - never a stream's "first chatter": the streamer greeting their own
//                        chat opens most streams, which is true of every channel and says nothing
function createChannelAccumulator({
  isEmote = () => false,
  botLogins = new Set(),
  candidateWords = new Set(),
  categoryAt = () => null,
  broadcasterLogin = null,
} = {}) {
  const state = {
    total: 0,
    users: new Map(), // userId -> { n, name }
    months: new Array(12).fill(0),
    hours: new Array(24).fill(0),
    minutes: new Map(), // minute index -> count
    sessions: [],
    current: null,
    commands: new Map(), // name -> { n, users: Map(userId -> n) }
    mentions: new Map(), // "from\u0000to" -> n
    firstUse: new Map(), // word -> { userId, name, at, text }
    categories: new Map(), // category -> messages
  };

  function closeSession() {
    if (state.current && state.current.messages >= SESSION_MIN_MESSAGES) state.sessions.push(state.current);
    state.current = null;
  }

  function add(doc) {
    const name = String(doc.userName || "").toLowerCase();
    if (!doc.userId || botLogins.has(name)) return;
    const at = new Date(doc.timestamp);
    const ts = at.getTime();
    const text = String(doc.message || "");

    state.total += 1;
    const user = state.users.get(doc.userId);
    if (user) {
      user.n += 1;
      user.name = name || user.name;
    } else {
      state.users.set(doc.userId, { n: 1, name });
    }

    const { month, hour } = localParts(at);
    state.months[month] += 1;
    state.hours[hour] += 1;

    const minute = Math.floor(ts / 60000);
    state.minutes.set(minute, (state.minutes.get(minute) || 0) + 1);

    if (state.current && ts - state.current.end > SESSION_GAP_MS) closeSession();
    if (!state.current) state.current = { start: ts, end: ts, messages: 0, firstUserId: null, firstName: null };
    if (!state.current.firstUserId && name !== broadcasterLogin) {
      state.current.firstUserId = doc.userId;
      state.current.firstName = name;
    }
    state.current.end = ts;
    state.current.messages += 1;

    const category = categoryAt(at);
    if (category) state.categories.set(category, (state.categories.get(category) || 0) + 1);

    const command = commandOf(text);
    if (command) {
      let c = state.commands.get(command);
      if (!c) state.commands.set(command, (c = { n: 0, users: new Map() }));
      c.n += 1;
      c.users.set(doc.userId, (c.users.get(doc.userId) || 0) + 1);
      return;
    }

    for (const target of extractMentions(text, [name])) {
      if (botLogins.has(target)) continue;
      const key = `${name}\u0000${target}`;
      state.mentions.set(key, (state.mentions.get(key) || 0) + 1);
    }

    if (candidateWords.size && !(doc.gifs && doc.gifs.length)) {
      for (const word of extractWords(text, isEmote)) {
        if (candidateWords.has(word) && !state.firstUse.has(word)) {
          state.firstUse.set(word, { userId: doc.userId, name, at, text: text.slice(0, 200) });
        }
      }
    }
  }

  function finish() {
    closeSession();
    return state;
  }

  return { add, finish, state };
}

// The minutes the chat was loudest, at most one per LOUD_SEPARATION_MS window.
function pickLoudMoments(minutes, { count = LOUD_MOMENTS, separationMs = LOUD_SEPARATION_MS } = {}) {
  const sorted = [...minutes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const picked = [];
  for (const [minute, n] of sorted) {
    const at = minute * 60000;
    if (picked.some((p) => Math.abs(p.at - at) < separationMs)) continue;
    picked.push({ at, n });
    if (picked.length >= count) break;
  }
  return picked;
}

// What the chat was shouting in a loud minute: the most repeated line, folded on case and
// whitespace. A burst is nearly always one emote or one phrase spammed, and that phrase is the
// moment's caption. Three people typing the streamer's name in a 280-line minute is not what the
// chat was shouting, so a chant must be a visible share of the minute.
const CHANT_MIN_REPEATS = 5;
const CHANT_MIN_SHARE = 0.03;

function chantOf(lines) {
  const counts = new Map();
  for (const line of lines) {
    const key = String(line || "").trim().replace(/\s+/g, " ");
    if (!key || key.startsWith("!")) continue;
    const folded = key.toLowerCase();
    const entry = counts.get(folded);
    if (entry) entry.n += 1;
    else counts.set(folded, { text: key.slice(0, 120), n: 1 });
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  const needed = Math.max(CHANT_MIN_REPEATS, Math.ceil(lines.length * CHANT_MIN_SHARE));
  return best && best.n >= needed ? best : null;
}

// Pairs who talked to EACH OTHER, not one person tagging another: ranked by the weaker direction,
// so a fan @-ing a streamer friend two hundred times with no answer does not top the list.
function topMutualPairs(mentions, { limit = 20, minEachWay = 3 } = {}) {
  const pairs = new Map();
  for (const [key, n] of mentions) {
    const [from, to] = key.split("\u0000");
    if (from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const pk = `${a}\u0000${b}`;
    let p = pairs.get(pk);
    if (!p) pairs.set(pk, (p = { a, b, ab: 0, ba: 0 }));
    if (from === a) p.ab += n;
    else p.ba += n;
  }
  return [...pairs.values()]
    .filter((p) => Math.min(p.ab, p.ba) >= minEachWay)
    .sort((x, y) => Math.min(y.ab, y.ba) - Math.min(x.ab, x.ba) || y.ab + y.ba - (x.ab + x.ba))
    .slice(0, limit)
    .map((p) => ({ a: p.a, b: p.b, total: p.ab + p.ba, ab: p.ab, ba: p.ba }));
}

function topCommands(commands, limit = 15) {
  return [...commands.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([name, c]) => {
      let topUserId = null;
      let topN = 0;
      for (const [userId, n] of c.users) {
        if (n > topN) {
          topN = n;
          topUserId = userId;
        }
      }
      return { name, n: c.n, users: c.users.size, topUserId, topN };
    });
}

// Ascending message counts of every chatter, for "you wrote more than X% of the chat".
function sortedCounts(users) {
  return [...users.values()].map((u) => u.n).sort((a, b) => a - b);
}

// Share of chatters who wrote FEWER messages than n (0..1), and the rank among all.
function standingOf(sorted, n) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  const below = lo;
  let hi2 = sorted.length;
  let lo2 = lo;
  while (lo2 < hi2) {
    const mid = (lo2 + hi2) >> 1;
    if (sorted[mid] <= n) lo2 = mid + 1;
    else hi2 = mid;
  }
  const above = sorted.length - lo2;
  return {
    share: sorted.length ? below / sorted.length : 0,
    rank: above + 1,
    of: sorted.length,
  };
}

const CHRONOTYPES = [
  { key: "night", from: 0, to: 6 },
  { key: "morning", from: 6, to: 12 },
  { key: "day", from: 12, to: 18 },
  { key: "evening", from: 18, to: 24 },
];

// The band of the day holding most of a person's messages, plus the single busiest hour.
function chronotypeOf(hours) {
  let best = CHRONOTYPES[0];
  let bestN = -1;
  for (const band of CHRONOTYPES) {
    let n = 0;
    for (let h = band.from; h < band.to; h++) n += hours[h] || 0;
    if (n > bestN) {
      bestN = n;
      best = band;
    }
  }
  let peakHour = 0;
  for (let h = 1; h < 24; h++) if ((hours[h] || 0) > (hours[peakHour] || 0)) peakHour = h;
  return { key: best.key, peakHour };
}

// Which of the channel's streams a person wrote in, the longest run of consecutive ones, and how
// many of them they opened. `sessions` are the channel's, ascending; `timestamps` ascending.
function attendanceOf(sessions, timestamps, userId) {
  const attended = new Set();
  let i = 0;
  for (const t of timestamps) {
    const ts = new Date(t).getTime();
    while (i < sessions.length && sessions[i].end < ts) i++;
    if (i >= sessions.length) break;
    if (sessions[i].start <= ts) attended.add(i);
  }
  let longest = 0;
  let run = 0;
  for (let s = 0; s < sessions.length; s++) {
    run = attended.has(s) ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const opened = sessions.filter((s) => s.firstUserId === userId).length;
  return { attended: attended.size, of: sessions.length, longestStreak: longest, opened };
}

// "Your word": the word this person says far more often than the chat does. Plain top-used would
// be "привет" for everyone. The ratio alone favours accidents: on local data a word said ten
// times (8 of the chat's 12 uses) beat a nickname said 138 times. Weighting by the person's own
// count fixes that, but linearly it hands the prize to a habit: a regular who greets 3.5x more
// than average got "привет" (326 uses, 7% of the chat's) over the nickname (138 uses, 23% of the
// chat's). Squaring the log keeps both forces - the count, and how much the word is THEIRS - with
// the second winning a close call; below MIN_RATIO a word is just the chat's, said a bit more.
const DISTINCTIVE_MIN_RATIO = 2;

function distinctiveWords(userCounts, userTotal, channelCounts, channelTotal, { minCount = 5, limit = 3 } = {}) {
  if (!userTotal || !channelTotal) return [];
  const scored = [];
  for (const [word, u] of userCounts) {
    if (u < minCount) continue;
    const c = Math.max(channelCounts.get(word) || 0, u);
    const ratio = ((u + 1) / (userTotal + 1)) / ((c + 1) / (channelTotal + 1));
    if (ratio < DISTINCTIVE_MIN_RATIO) continue;
    scored.push({ word, n: u, channelN: c, score: u * Math.log(ratio) ** 2, share: c ? u / c : 1 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Emote tokens in one message, each counted once per message - the same rule the emote index uses.
function emotesIn(message, isEmote) {
  const seen = new Set();
  for (const raw of String(message || "").trim().split(/\s+/)) {
    if (raw && isEmote(raw)) seen.add(raw);
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// The guessing game on the personal page: a question, the options, the index of the right one.
// Options are shuffled with a seeded generator, so a reload asks the same question the same way
// (a reshuffle on reload turns "guess" into "click until you remember").
// ---------------------------------------------------------------------------------------------

function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rnd) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function withAnswer(kind, correct, distractors, rnd) {
  const unique = [];
  for (const d of distractors) {
    if (d === correct || unique.includes(d)) continue;
    unique.push(d);
    if (unique.length === 3) break;
  }
  if (unique.length === 0) return null;
  const options = shuffle([correct, ...unique], rnd);
  return { kind, options, answer: options.indexOf(correct) };
}

// Rough magnitude buckets for "how many messages did you write". The buckets are fixed, so the
// options are honest ranges rather than three invented numbers around the real one.
const MESSAGE_BUCKETS = [0, 100, 500, 1000, 2500, 5000, 10000, 25000];

function messageBucketIndex(n) {
  let i = 0;
  while (i + 1 < MESSAGE_BUCKETS.length && n >= MESSAGE_BUCKETS[i + 1]) i++;
  return i;
}

function buildQuiz(personal, { channelEmotes = [], channelChatters = [], seed = "" } = {}) {
  const rnd = seededRandom(seed);
  const quiz = [];

  // Messages: the right bucket and its neighbours, so the choice is between plausible ranges.
  const b = messageBucketIndex(personal.messages);
  const near = [b - 1, b + 1, b - 2, b + 2].filter((x) => x >= 0 && x < MESSAGE_BUCKETS.length);
  const q1 = withAnswer("messages", b, near, rnd);
  if (q1) quiz.push(q1);

  // Time of day: always the four bands.
  const bands = CHRONOTYPES.map((c) => c.key);
  quiz.push({ kind: "chronotype", options: bands, answer: bands.indexOf(personal.chronotype.key) });

  const topEmote = personal.emotes[0]?.name;
  if (topEmote) {
    const q = withAnswer("emote", topEmote, shuffle(channelEmotes, rnd), rnd);
    if (q) quiz.push(q);
  }

  const partner = personal.partners[0]?.login;
  if (partner) {
    const others = channelChatters.filter((l) => l !== partner && !personal.partners.some((p) => p.login === l));
    const q = withAnswer("partner", partner, shuffle(others, rnd), rnd);
    if (q) quiz.push(q);
  }

  return quiz;
}

module.exports = {
  TZ_OFFSET_MS,
  SESSION_GAP_MS,
  SESSION_MIN_MESSAGES,
  MESSAGE_BUCKETS,
  CHRONOTYPES,
  yearRange,
  localParts,
  currentYear,
  commandOf,
  reasonKind,
  createChannelAccumulator,
  pickLoudMoments,
  chantOf,
  topMutualPairs,
  topCommands,
  sortedCounts,
  standingOf,
  chronotypeOf,
  attendanceOf,
  distinctiveWords,
  emotesIn,
  buildQuiz,
  messageBucketIndex,
  seededRandom,
};
