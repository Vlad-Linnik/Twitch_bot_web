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

// Emotes have NO usage threshold: a channel's whole set is in play, every emote anyone has ever
// typed there. There is nothing for a threshold to filter out - a token only reaches this index
// if it is in the channel's whiteList to begin with, so unlike the word pool it holds no typos and
// no transliteration, which is the only thing WORD_MIN_COUNT is really for.
//
// The cost is measured and accepted rather than unnoticed. Including the tail (116 emotes under 10
// uses on #mistercop, 69 of them used once or twice) makes the mode MORE lopsided, because those
// meet `))` at 278,868: pairs 5x or further apart go from 55.8% to 66.1% and the median ratio from
// 6.3x to 12.4x. It also admits a channel that a threshold kept out - #otira_ has 149 emotes but
// 84 of them used at most twice, so a fifth of its pairs are decided by a count of 1 against 2.
// Same call as the unweighted draw in pickChallenger: show the channel's real set, do not curate.
const EMOTE_MIN_COUNT = 1;

// A channel appears in the picker only if its pool clears this. Below it the same few tokens come
// back every handful of rounds and the game turns into remembering the previous round rather than
// knowing the chat. It is the only gate the emote mode has left now that EMOTE_MIN_COUNT admits
// everything: #meowgumin's 7 emotes stay out, #otira_'s 149 get in.
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

// ---------------------------------------------------------------------------------------
// Player votes
//
// Players rate the words they are shown and the example lines under them, and BOTH ratings work
// the same way: a like holds the thing where it is, dislikes lower how often it turns up, and far
// enough down it stops turning up at all. For a word that means how often it is dealt; for a line
// it means how often it is printed under its word. One curve, one constant, one explanation.
//
// A like does NOT push anything above the ordinary chance. It cancels dislikes and nothing more -
// which is exactly "лайк оставляет слово в пуле". The alternative, letting likes multiply, hands
// a handful of enthusiasts the ability to flood every run with their favourites, and there is no
// competing pressure to balance it: nobody dislikes a word for being too common.
// ---------------------------------------------------------------------------------------

// Net score at which something stops appearing entirely. Far enough down that a couple of grumpy
// players cannot delete a word from the game between them.
const VOTE_EXCLUDE_AT = -5;

// Chance multiplier for a net score. 1 is the ordinary chance; -1 halves it, -4 leaves a fifth,
// -5 removes it. Applied by rejection sampling, so no ordering or prefix sums are needed.
function weightFor(net) {
  const score = Number.isFinite(net) ? net : 0;
  if (score >= 0) return 1;
  if (score <= VOTE_EXCLUDE_AT) return 0;
  return 1 / (1 + Math.abs(score));
}

// Whether a thing with this net score appears on this particular draw.
function passesVote(net, rng = Math.random) {
  const weight = weightFor(net);
  if (weight >= 1) return true;
  if (weight <= 0) return false;
  return rng() < weight;
}

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
// apart), while emotes span from `))` at 278,868 down to a tail used once (median ratio 12.4x,
// 66% of pairs >=5x apart). So two thirds of all emote rounds are decidable without knowing the
// chat at all. Restricting the draw to a band around the anchor would fix that and was rejected
// in favour of the honest, unweighted draw - this comment exists so the 66% reads as a decision
// rather than as a defect waiting to be repaired.
// `votes` is word -> net score; anything absent from it has never been rated and is drawn at the
// ordinary chance. Applied by REJECTION sampling - draw uniformly, then keep the candidate with
// probability weightFor(net) - because the alternative, a prefix-sum table over the weights, would
// have to be rebuilt for a pool of thousands every time one person pressed a thumb, to change the
// odds for the handful of words anyone has actually voted on.
function pickChallenger(pool, anchor, recent, rng = Math.random, votes = null) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const blocked = new Set(recent || []);
  blocked.add(anchor.word);
  const netOf = (word) => (votes && votes.has(word) ? votes.get(word) : 0);

  for (let i = 0; i < MAX_DRAW_ATTEMPTS; i++) {
    const candidate = pool[Math.floor(rng() * pool.length)];
    if (!candidate || blocked.has(candidate.word)) continue;
    if (!isPlayablePair(anchor, candidate)) continue;
    if (!passesVote(netOf(candidate.word), rng)) continue;
    return candidate;
  }

  // Nothing came up by chance: take every candidate that would do and pick among those. Words
  // voted out entirely stay out here too, but a merely unpopular one is no longer penalised - by
  // this point it is the difference between an odd word and no round at all. Returning null is
  // not a failure state: it means this anchor has no legal opponent left, which the caller turns
  // into a cleared run rather than a loss.
  const eligible = pool.filter(
    (row) => !blocked.has(row.word) && isPlayablePair(anchor, row) && weightFor(netOf(row.word)) > 0
  );
  if (eligible.length === 0) return null;
  return eligible[Math.floor(rng() * eligible.length)];
}

// The opening pair. The anchor is drawn under the same weighting, so a word nobody wants does not
// get in through the front door either.
function pickOpeningPair(pool, rng = Math.random, votes = null) {
  if (!Array.isArray(pool) || pool.length < 2) return null;
  const netOf = (word) => (votes && votes.has(word) ? votes.get(word) : 0);

  let anchor = null;
  for (let i = 0; i < MAX_DRAW_ATTEMPTS; i++) {
    const candidate = pool[Math.floor(rng() * pool.length)];
    if (candidate && passesVote(netOf(candidate.word), rng)) {
      anchor = candidate;
      break;
    }
  }
  if (!anchor) {
    const eligible = pool.filter((row) => weightFor(netOf(row.word)) > 0);
    if (eligible.length === 0) return null;
    anchor = eligible[Math.floor(rng() * eligible.length)];
  }

  const challenger = pickChallenger(pool, anchor, [], rng, votes);
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
  VOTE_EXCLUDE_AT,
  weightFor,
  passesVote,
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
