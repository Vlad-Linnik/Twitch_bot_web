// Pure rules for the "Выше — ниже" game (/games/higher-lower): which words/emotes are eligible
// to appear, how a pair is drawn, and whether a guess was right. No I/O - db/higherLowerRepo.js
// runs the queries, routes/higherLower.js owns the run state, and everything decidable without
// Mongo lives here so tests/higherLower.test.js can cover it.
//
// The number a card shows is "in how many MESSAGES this token appeared", not how many times it
// was typed: both the word index (ChatWordStats, via lib/textStats.js's extractWords, which
// dedupes through a Set) and the emote index (words/WordLifetimeStats, "each word counts at most
// once per message") count once per message. The view says «в N сообщениях» for that reason.

const MODES = ["words", "emotes"];
const PERIODS = ["all", "month"];

// Minimum count for a token to enter the pool at all. Measured on production (#mistercop) rather
// than guessed, and the measurement is counter-intuitive enough to record: raising this threshold
// does NOT make the game easier. Over 20k random pairs the share of "obvious" pairs (>=5x apart)
// FALLS as the threshold rises - 24% at >=25, 17% at >=100, 7.5% at >=500 - because the surviving
// counts bunch together. What the threshold actually buys is recognisability: at >=25 the pool is
// full of typos and transliteration ("ааххаха", "фусиляду", "китаве"), at >=100 it is the
// channel's real vocabulary ("миссует", "депал", "абис"). So this is a word-quality knob.
//
// The month window holds roughly a twelfth of the traffic, so its threshold is scaled down to
// keep a comparable pool: 7558 words all-time vs 2861 for a month on #mistercop.
const WORD_MIN_COUNT = { all: 100, month: 25 };

// Emotes get one number for both periods. Their whole vocabulary is a few hundred tokens (676 on
// #mistercop, 149 on #otira_), so there is no room to scale a threshold down - and unlike words
// there is no junk to filter out, since a token only reaches this index if it is in the channel's
// whiteList to begin with.
const EMOTE_MIN_COUNT = 10;

// A channel appears in the picker only if its pool clears this. Below it the same few tokens come
// back every handful of rounds and the game turns into remembering the previous round rather than
// knowing the chat. #otira_ has 18 emotes over the threshold and 9 words - it is correctly absent
// until its chat grows into one.
const MIN_CHANNEL_POOL = { words: 150, emotes: 40 };

// A pair whose counts are this close is a coin toss, not a question - no amount of knowing the
// chat separates 208 from 214. Rejecting them costs a redraw in memory and nothing else. It bites
// unevenly by mode (14.6% of word pairs, 4.6% of emote pairs) because the two distributions are
// nothing alike; see pickChallenger for the other half of that story.
const MIN_GAP = 0.15;

// How many tokens back the game refuses to repeat itself. Bounded rather than "everything seen in
// this run" because the emote pool can be as small as 40: forbidding every past token would
// starve a long run into ending on an empty pool rather than on a mistake.
const RECENT_MEMORY = 40;

// Random draws before falling back to a full scan. The fast path is what runs essentially always
// (a rejected draw is rare); the scan exists so that a pool where almost nothing clears MIN_GAP
// against the current anchor still finds the candidate that does, instead of ending the run.
const MAX_DRAW_ATTEMPTS = 40;

function isMode(value) {
  return MODES.includes(value);
}

function isPeriod(value) {
  return PERIODS.includes(value);
}

function minCount(mode, period) {
  return mode === "emotes" ? EMOTE_MIN_COUNT : WORD_MIN_COUNT[period];
}

function minChannelPool(mode) {
  return MIN_CHANNEL_POOL[mode];
}

function isChannelPlayable(mode, poolSize) {
  return poolSize >= minChannelPool(mode);
}

// Relative distance between two counts, measured against the larger one so the test is symmetric.
function gap(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi <= 0) return 0;
  return (hi - lo) / hi;
}

function isPlayablePair(a, b) {
  return a.word !== b.word && gap(a.count, b.count) >= MIN_GAP;
}

// The challenger is drawn from the WHOLE pool, in both modes.
//
// That is a deliberate choice with a known cost in the emote mode. The two distributions are not
// alike: words sit close together (median ratio 2.0x between a random pair, 17% of pairs >=5x
// apart), while emotes span from `))` at 278,868 down to a tail at 10-15 (median ratio 6.3x, 56%
// of pairs >=5x apart). So better than half of all emote rounds are decidable without knowing the
// chat at all. Restricting the draw to a band around the anchor would fix that and was rejected
// in favour of the honest, unweighted draw - this comment exists so the 56% reads as a decision
// rather than as a defect waiting to be repaired.
function pickChallenger(pool, anchor, recent, rng = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const blocked = new Set(recent || []);
  blocked.add(anchor.word);

  for (let i = 0; i < MAX_DRAW_ATTEMPTS; i++) {
    const candidate = pool[Math.floor(rng() * pool.length)];
    if (!candidate || blocked.has(candidate.word)) continue;
    if (isPlayablePair(anchor, candidate)) return candidate;
  }

  // Nothing came up by chance: take every candidate that would do and pick among those. Returning
  // null here is not a failure state - it means this anchor has no legal opponent left, which the
  // caller turns into a cleared run rather than a loss.
  const eligible = pool.filter((row) => !blocked.has(row.word) && isPlayablePair(anchor, row));
  if (eligible.length === 0) return null;
  return eligible[Math.floor(rng() * eligible.length)];
}

// The opening pair. The anchor is unweighted too, so a run can start anywhere in the pool.
function pickOpeningPair(pool, rng = Math.random) {
  if (!Array.isArray(pool) || pool.length < 2) return null;
  const anchor = pool[Math.floor(rng() * pool.length)];
  const challenger = pickChallenger(pool, anchor, [], rng);
  if (!challenger) return null;
  return { anchor, challenger };
}

// MIN_GAP guarantees the two counts differ, so there is no tie case to arbitrate - a pair that
// somehow arrived equal is treated as a wrong guess either way rather than silently given to the
// player, which would be the shape a bug hides in.
function isCorrect(anchorCount, challengerCount, guess) {
  if (guess === "higher") return challengerCount > anchorCount;
  if (guess === "lower") return challengerCount < anchorCount;
  return false;
}

// Bounded to RECENT_MEMORY, newest first.
function rememberToken(recent, word) {
  const next = [word, ...(recent || []).filter((w) => w !== word)];
  return next.slice(0, RECENT_MEMORY);
}

module.exports = {
  MODES,
  PERIODS,
  MIN_GAP,
  RECENT_MEMORY,
  WORD_MIN_COUNT,
  EMOTE_MIN_COUNT,
  MIN_CHANNEL_POOL,
  isMode,
  isPeriod,
  minCount,
  minChannelPool,
  isChannelPlayable,
  gap,
  isPlayablePair,
  pickChallenger,
  pickOpeningPair,
  isCorrect,
  rememberToken,
};
