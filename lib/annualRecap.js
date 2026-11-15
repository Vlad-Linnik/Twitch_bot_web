// The annual recap's arithmetic: everything that decides WHAT the recap says, kept free of Mongo
// so it can be tested. jobs/annualRecap.js feeds it the channel's messages in time order;
// db/annualRecapUserService.js feeds it one viewer's.
//
// The recap is about the chat, not about watching: Twitch's own recap already tells a viewer how
// many hours they watched, and that is the one thing we cannot measure. What only this bot sees is
// who talked to whom, which words the chat invented, and the minutes the chat shouted - shown only
// with a clip a viewer made of them, because a minute without the video is a date and a number.
const { extractWords, extractMentions } = require("./textStats");
const { stem } = require("./russianStemmer");

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

const COMMAND_MAX_LENGTH = 25;

// Loud minutes: more candidates are picked than shown, because a moment nobody clipped is dropped.
const LOUD_CANDIDATES = 15;
// Two peaks closer than this are the same moment of the same stream.
const LOUD_SEPARATION_MS = 30 * 60 * 1000;
// Which clip shows a moment. A clip's created_at is when the button was pressed, and a clip can
// be cut from the VOD days later, so created_at alone says little. What the clip SHOWS is known
// when its VOD still exists: the stream's start + vod_offset. Measured on #mistercop, 17 April:
// the nearest clip by created_at was made nine minutes after the loudest minute of the year.
//  - with a VOD: the clip's content must overlap the peak minute, give or take CLIP_CONTENT_SLACK;
//  - without one (VODs expire): only a clip made within CLIP_LIVE_AFTER of the peak counts - a
//    live clip holds the ~30 s before the press, so a press minutes later shows something else.
const CLIP_CONTENT_SLACK_MS = 60 * 1000;
const CLIP_LIVE_AFTER_MS = 3 * 60 * 1000;
// How long after a moment clips are fetched for it: covers clips cut from the VOD later on.
const CLIP_SEARCH_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

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
// options.commandAliases - Map alias -> command (both without "!", lowercase) - see
//                        commandAliasMap below
// options.broadcasterLogin - never a stream's "first chatter": the streamer greeting their own
//                        chat opens most streams, which is true of every channel and says nothing
function createChannelAccumulator({
  isEmote = () => false,
  botLogins = new Set(),
  candidateWords = new Set(),
  categoryAt = () => null,
  broadcasterLogin = null,
  commandAliases = new Map(),
} = {}) {
  const state = {
    total: 0,
    users: new Map(), // userId -> { n, name }
    months: new Array(12).fill(0),
    hours: new Array(24).fill(0),
    sessions: [],
    current: null,
    commands: new Map(), // name -> { n, users: Map(userId -> n) }
    mentions: new Map(), // "from\u0000to" -> n
    firstUse: new Map(), // word -> { userId, name, at, text }
    categories: new Map(), // category -> messages
    minutes: new Map(), // minute index -> messages
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

    const typed = commandOf(text);
    const command = typed ? commandAliases.get(typed) || typed : null;
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
function pickLoudMoments(minutes, { count = LOUD_CANDIDATES, separationMs = LOUD_SEPARATION_MS } = {}) {
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
// whitespace. Three people typing the streamer's name in a 280-line minute is not what the chat
// was shouting, so a chant must be a visible share of the minute.
const CHANT_MIN_REPEATS = 5;
// A clip's stretch of chat is a minute or less of an ordinary stream, not a burst: three people
// typing the same line there is already the chat's reaction.
const CLIP_CHANT_MIN_REPEATS = 3;
const CHANT_MIN_SHARE = 0.03;

function chantOf(lines, { minRepeats = CHANT_MIN_REPEATS } = {}) {
  const counts = new Map(); // folded key -> { n, spellings: Map(text -> n) }
  for (const line of lines) {
    const text = String(line || "").trim().replace(/\s+/g, " ");
    if (!text || text.startsWith("!")) continue;
    // «фу сука» and «фуууууууу сука» are one chant: case and stretched letters are folded for the
    // count, and the spelling chat used most is what the page shows.
    const key = text.toLowerCase().replace(/(.)\1+/gu, "$1");
    let entry = counts.get(key);
    if (!entry) counts.set(key, (entry = { n: 0, spellings: new Map() }));
    entry.n += 1;
    entry.spellings.set(text, (entry.spellings.get(text) || 0) + 1);
  }
  let best = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  const needed = Math.max(minRepeats, Math.ceil(lines.length * CHANT_MIN_SHARE));
  if (!best || best.n < needed) return null;
  const spelling = [...best.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { text: spelling.slice(0, 120), n: best.n };
}

// The created_at range to fetch clips for a moment at `at` (ms) - Helix Get Clips's
// started_at/ended_at.
function clipWindow(at) {
  return { from: new Date(at - CLIP_CONTENT_SLACK_MS), to: new Date(at + CLIP_SEARCH_AFTER_MS) };
}

// Whether a Helix clip shows the minute starting at `at`. `videoStart` is its VOD's start (Date)
// or null when the VOD is gone.
function clipShowsMoment(clip, at, videoStart) {
  if (videoStart && clip.vod_offset !== null && clip.vod_offset !== undefined) {
    const from = videoStart.getTime() + clip.vod_offset * 1000;
    const to = from + (clip.duration || 30) * 1000;
    return to >= at - CLIP_CONTENT_SLACK_MS && from <= at + 60000 + CLIP_CONTENT_SLACK_MS;
  }
  const created = Date.parse(clip.created_at);
  return created >= at && created <= at + 60000 + CLIP_LIVE_AFTER_MS;
}

// The stretch of chat that goes with a clip: from what the clip shows to a little after it, since
// chat reacts to a stream it watches with a delay. What the clip shows is the VOD start + offset
// when the VOD exists; without it, a live clip holds the `duration` seconds before it was made.
const CHAT_REACTION_LAG_MS = 20 * 1000;
function clipChatWindow(clip, videoStart) {
  const durationMs = (clip.duration || 30) * 1000;
  let from;
  if (videoStart && clip.vod_offset !== null && clip.vod_offset !== undefined) {
    from = videoStart.getTime() + clip.vod_offset * 1000;
  } else {
    from = Date.parse(clip.created_at) - durationMs;
  }
  return { from: new Date(from), to: new Date(from + durationMs + CHAT_REACTION_LAG_MS) };
}

// Of Helix clip objects, the one that shows the moment, most viewed (the clip chat itself passed
// around), earliest on a tie. Null when nobody clipped it. `videoStarts`: Map<videoId, Date>.
function pickClipForMoment(clips, at, videoStarts = new Map()) {
  let best = null;
  for (const c of clips || []) {
    const created = Date.parse(c.created_at);
    if (!clipShowsMoment(c, at, videoStarts.get(String(c.video_id)) || null)) continue;
    if (!best || c.view_count > best.view_count || (c.view_count === best.view_count && created < Date.parse(best.created_at))) {
      best = c;
    }
  }
  return best;
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

// ---------------------------------------------------------------------------------------------
// Word forms. The indexes count every spelling apart, so the year's lists showed «табакошка» (503)
// and «табакошку» (344) as two words, and «чат»/«чате» as two of the top five. Russian is
// inflected; a word-of-the-year list is about the word. Grouped by Snowball stem
// (lib/russianStemmer.js, a copy of the bot's): case endings fold, different words stay apart.
// A token with no Cyrillic in it is its own key - the stemmer is for Russian, and an emote-like
// Latin token must not be cut.
// ---------------------------------------------------------------------------------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formKey(word) {
  const w = String(word || "").toLowerCase();
  return /[а-яё]/.test(w) ? stem(w) : w;
}

// rows: [{word, n, ...}] -> [{word, n, forms, key}], where `word` is the most used form (the one
// people will recognise), `n` the sum and `forms` every spelling seen, most used first.
function groupWordForms(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = formKey(row.word);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, n: 0, forms: [] }));
    g.n += row.n;
    g.forms.push({ word: row.word, n: row.n });
  }
  return [...groups.values()]
    .map((g) => {
      g.forms.sort((a, b) => b.n - a.n);
      return { word: g.forms[0].word, n: g.n, forms: g.forms.map((f) => f.word), key: g.key };
    })
    .sort((a, b) => b.n - a.n);
}

// alias -> command from the channel's custom_commands rows ({command, aliases}). "!билд" is
// "!build" typed on a Russian layout; counted apart, one command shows up twice in the top with
// its count split in half. The aliases are today's, not the year's - a renamed alias counts under
// whatever it is now, which is the right answer for "which command was called most".
function commandAliasMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const command = String(row.command || "").toLowerCase().replace(/^!/, "");
    if (!command) continue;
    for (const alias of row.aliases || []) {
      const a = String(alias || "").toLowerCase().replace(/^!/, "");
      if (a && a !== command && !map.has(a)) map.set(a, command);
    }
  }
  return map;
}

// The aliases each command has, for showing "!build (!билд)".
function aliasesByCommand(aliasMap) {
  const out = new Map();
  for (const [alias, command] of aliasMap) {
    if (!out.has(command)) out.set(command, []);
    out.get(command).push(alias);
  }
  return out;
}

function topCommands(commands, limit = 15, aliasMap = new Map()) {
  const aliasesOf = aliasesByCommand(aliasMap);
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
      return { name, aliases: aliasesOf.get(name) || [], n: c.n, users: c.users.size, topUserId, topN };
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
  clipWindow,
  clipShowsMoment,
  clipChatWindow,
  CLIP_CHANT_MIN_REPEATS,
  pickClipForMoment,
  topMutualPairs,
  topCommands,
  commandAliasMap,
  formKey,
  groupWordForms,
  escapeRegExp,
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
