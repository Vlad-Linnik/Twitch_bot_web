// Pure rules for the "Выше — ниже" game (/games/higher-lower): which words/emotes are eligible
// to appear, how a pair is drawn, and whether a guess was right. No I/O - db/higherLowerRepo.js
// runs the queries, routes/higherLower.js owns the run state, and everything decidable without
// Mongo lives here so tests/higherLower.test.js can cover it.
//
// The number a card shows is "in how many MESSAGES this token appeared", not how many times it
// was typed: both the word index (ChatWordStats, via lib/textStats.js's extractWords, which
// dedupes through a Set) and the emote index (words/WordLifetimeStats, "each word counts at most
// once per message") count once per message. The view says «в N сообщениях» for that reason.

const { VOTE_EXCLUDE_AT, weightFor, passesVote } = require("./voteWeight");

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

// How many rounds are dealt AHEAD of the one on screen. The count a card hides is the answer, so
// it can never be sent early - but everything else about a card can be, and dealing it early is
// what takes the pool read, the emote-image fetch and the example lookup off the path between the
// player's click and the number counting up. Two is enough that a refill has a whole round (a
// count-up, a flash and a slide - well over a second) to land before the card it produced is
// needed, and small enough that a vote cast now still changes the draw two rounds later.
const QUEUE_DEPTH = 2;

// Random draws before falling back to a full scan. The fast path is what runs essentially always
// (a rejected draw is rare); the scan exists so that a pool where almost nothing clears MIN_GAP
// against the current anchor still finds the candidate that does, instead of ending the run.
const MAX_DRAW_ATTEMPTS = 40;

// ---------------------------------------------------------------------------------------
// Oddity rounds
//
// Every so often the challenger is not an ordinary pool word at all but a curiosity, and there
// are two kinds of those. A RARE word - one said in a handful of messages in the channel's whole
// history. And a LONG one - «наэлектролизованная», «бутылко-собирателей» - however few times it
// was said, which is almost always once. Neither number is knowable, and that is the point: the
// round stops being a question and turns into a reveal, «в 1 сообщении» under a word nobody
// remembers anyone typing.
// ---------------------------------------------------------------------------------------

// The band a rare word is drawn from, in messages. Absolute counts rather than "anything under
// WORD_MIN_COUNT", and both ends are measured on production (#mistercop: 367,421 words all-time,
// 1.93M messages):
//
// - the floor keeps out a count of 1 - 214,333 words, three fifths of the whole vocabulary and
//   overwhelmingly one-off typing noise. Said twice is at least said twice. A LONG word is taken
//   at a count of 1 all the same: there the word itself is the exhibit, and its length is already
//   evidence that somebody typed it on purpose.
// - the ceiling is what keeps the surprise. The gap below WORD_MIN_COUNT.all is 100,000 words
//   wide and its upper half reads like any other card: a reveal of 87 is not astonishing. Inside
//   this band the mean count of a drawn word is 3.7.
//
// The band also sits strictly below BOTH word thresholds (25 for a month, 100 for all time),
// which is what lets a rare card be recognised by its count alone - see isOddCard.
const RARE_COUNT = { min: 2, max: 9 };

// What makes a word long enough to be dealt for its length alone. Every number here is measured,
// because the honest version of this band - "the longest words this chat has" - is mostly
// keyboard mash: of the 5,798 words of 18 characters or more on #mistercop, two thirds are
// «ахахаххахахаха», «выфхвыавхывахфвхвазхфаывы» or the tail of a pasted asset id.
//
// - minLength 18 is where a Russian word becomes a mouthful. At 16 the band fills up with
//   ordinary long words and code-ish tokens («host_writeconfig», «previouscomprank»); from 18 up
//   what survives reads like an exhibit («видеодоказательства», «переименовываешься»).
// - minDistinctRatio is the mash filter and does most of the work: laughter and home-row noise
//   reuse three or four characters across twenty, real words do not. Half the characters
//   distinct cuts those 5,798 words to 2,437 and takes almost nothing real with it.
// - maxRepeat removes the padding a ratio alone lets through - «чааааааааат», «бляяяяяя», and
//   the «...aaaaaa...» inside a pasted id. No Russian word runs one letter three times.
// - digits are what the junk that is left has in common: ids, timestamps and URL fragments carry
//   them and words do not.
//
// Three rules, 1,991 words left of 5,798. A fourth - a minimum share of letters - was measured
// and dropped: it removed 23 more rows, which is not a rule, it is a coincidence.
const LONG_WORD = { minLength: 18, minDistinctRatio: 0.5, maxRepeat: 2 };

// How often a round is an oddity, and how it splits between the two bands. One knob for the rate
// rather than one per band, because the cost is the same whichever band it came from: an oddity
// card becomes the next round's anchor, and a round anchored on a count of 1 is nearly free (see
// drawOdd). At 12% roughly a quarter of all rounds are touched - one oddity and its easy
// neighbour per eight - and a run of a dozen rounds shows one or two.
const ODD_CHANCE = 0.12;
const LONG_SHARE = 0.5;

// ---------------------------------------------------------------------------------------
// Player votes
//
// Players rate the words they are shown and the example lines under them, and BOTH ratings work
// the same way: a like holds the thing where it is, dislikes lower how often it turns up, and far
// enough down it stops turning up at all. For a word that means how often it is dealt; for a line
// it means how often it is printed under its word. One curve, one constant, one explanation - and
// the curve itself lives in lib/voteWeight.js, because "Угадай чатера" rates what it deals on
// exactly the same terms. Re-exported here so this module stays the one place this game is read
// from.
// ---------------------------------------------------------------------------------------

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

// Whether a word is long enough, and word-like enough, to be dealt for its length - see
// LONG_WORD. Pure and exported because two places need the same answer: db/higherLowerRepo.js
// filters its sample with it (four rules deep is not an aggregation stage anybody can test), and
// isOddCard has to recognise a long card that is already on the table.
function isLongWord(word) {
  const chars = [...String(word || "").toLowerCase()];
  if (chars.length < LONG_WORD.minLength) return false;
  if (/\p{Nd}/u.test(word)) return false;
  let repeat = 1;
  for (let i = 1; i < chars.length; i++) {
    repeat = chars[i] === chars[i - 1] ? repeat + 1 : 1;
    if (repeat > LONG_WORD.maxRepeat) return false;
  }
  return new Set(chars).size / chars.length >= LONG_WORD.minDistinctRatio;
}

// Whether a card came out of either band - by its count and by the word itself, because {word,
// count} is all a card carries once it has been stored in a run, and a flag on it would not
// survive the round. The rare half of the test is exact: that band is strictly below every
// word-pool threshold, so no ordinary word can be mistaken for one. (An emote can, since the
// emote pool starts at a count of 1. It never matters - the emote mode is handed no bands at all,
// having no threshold for anything to be under.)
function isOddCard(token) {
  if (!token) return false;
  return token.count <= RARE_COUNT.max || isLongWord(token.word);
}

function hasOddBands(odd) {
  if (!odd) return false;
  return (odd.rare && odd.rare.length > 0) || (odd.long && odd.long.length > 0);
}

// One shot at a band, and no full-scan fallback like the one in pickChallenger: a draw that finds
// nothing simply becomes an ordinary round, which is the right outcome for a garnish. Votes apply
// here exactly as they do anywhere else - an oddity is still a card players can thumb down.
function drawFrom(band, anchor, blocked, rng, netOf) {
  for (let i = 0; i < MAX_DRAW_ATTEMPTS; i++) {
    const candidate = band[Math.floor(rng() * band.length)];
    if (!candidate || blocked.has(candidate.word)) continue;
    if (!isPlayablePair(anchor, candidate)) continue;
    if (!passesVote(netOf(candidate.word), rng)) continue;
    return candidate;
  }
  return null;
}

// The oddity round: pick a band, draw one card out of it.
//
// An oddity never follows an oddity - that is pickChallenger's isOddCard check, not this one.
// The round after one is nearly free: the anchor shows 1, so anything out of the pool proper is
// "higher", and that is the accepted price of the surprise. Two in a row would be worse than
// free - 4 against 7 is not a question anyone can answer from knowing the chat, only a coin toss
// that MIN_GAP happens to allow.
function drawOdd(odd, anchor, blocked, rng, netOf) {
  const long = (odd && odd.long) || [];
  const rare = (odd && odd.rare) || [];
  let band = rng() < LONG_SHARE ? long : rare;
  // A channel can have one band and not the other (#otira_ has four long words to #mistercop's
  // two thousand), so an empty band hands the round to its neighbour instead of spending the
  // coin on nothing.
  if (!band.length) band = band === long ? rare : long;
  if (!band.length) return null;
  return drawFrom(band, anchor, blocked, rng, netOf);
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
// `odd` is the two oddity bands as {rare, long} (db/higherLowerRepo.js's getOddPools), or nothing
// at all - the emote mode has neither, and neither had this game before oddities existed.
function pickChallenger(pool, anchor, recent, rng = Math.random, votes = null, odd = null) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const blocked = new Set(recent || []);
  blocked.add(anchor.word);
  const netOf = (word) => (votes && votes.has(word) ? votes.get(word) : 0);

  // The oddity round. The bands are checked for emptiness BEFORE the coin is tossed, so a caller
  // that passes none consumes exactly the rng sequence it always did.
  if (hasOddBands(odd) && !isOddCard(anchor) && rng() < ODD_CHANCE) {
    const unusual = drawOdd(odd, anchor, blocked, rng, netOf);
    if (unusual) return unusual;
  }

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
// get in through the front door either - and always from the pool proper, never from a band: the
// anchor's number is on screen before the player has done anything, so an opening on a count of 1
// would hand out the first round rather than ask for it. The challenger may be an oddity.
function pickOpeningPair(pool, rng = Math.random, votes = null, odd = null) {
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

  const challenger = pickChallenger(pool, anchor, [], rng, votes, odd);
  if (!challenger) return null;
  return { anchor, challenger };
}

// Draws a chain of up to `count` challengers, each one against the previous - which is what makes
// it a chain rather than a handful of cards: every card in the queue will in its turn become the
// anchor for the one behind it, so MIN_GAP has to hold between neighbours, not against the token
// that happens to be on screen now.
//
// Returns what was dealt plus the grown `recent` window, because the caller has to store both: a
// word already sitting in the queue must not be drawn again while it waits its turn. A short
// result is normal and not an error - it means this chain ran out of legal opponents, which the
// caller turns into a cleared run once the queue empties.
function dealAhead(pool, from, recent, count, rng = Math.random, votes = null, odd = null) {
  const dealt = [];
  let anchor = from;
  let seen = recent || [];
  for (let i = 0; i < count; i++) {
    const next = pickChallenger(pool, anchor, seen, rng, votes, odd);
    if (!next) break;
    dealt.push(next);
    seen = rememberToken(seen, next.word);
    anchor = next;
  }
  return { dealt, recent: seen };
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
  QUEUE_DEPTH,
  WORD_MIN_COUNT,
  EMOTE_MIN_COUNT,
  MIN_CHANNEL_POOL,
  RARE_COUNT,
  LONG_WORD,
  ODD_CHANCE,
  LONG_SHARE,
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
  isLongWord,
  isOddCard,
  pickChallenger,
  pickOpeningPair,
  dealAhead,
  isCorrect,
  rememberToken,
};
