// Pure rules for "Угадай чатера" (/games/guess-chatter): which chat line may become a question,
// how the four options are drawn, and how a run is assembled. No I/O - db/guessChatterRepo.js
// stores the pool, jobs/guessChatter.js builds it, routes/guessChatter.js serves a run, and
// everything decidable without Mongo lives here so tests/guessChatter.test.js can cover it.
//
// The game shows one real chat line and four logins, one of them its author. There is no
// leaderboard, and that is load-bearing rather than an omission: with no score to protect, the
// whole run - answers included - goes to the browser in one request, so there is no run document,
// no per-round endpoint and no resume logic. Compare routes/higherLower.js, where the count IS the
// answer and the server therefore has to keep it.
const { aiTextKey } = require("./aiTextKey");
const { extractWords, extractMentions } = require("./textStats");

// ---------------------------------------------------------------------------------------
// Who can be asked about
// ---------------------------------------------------------------------------------------

// The candidate pool is the channel's most active logins. This number is ASSIGNED, not derived,
// and the measurement is what says it cannot be derived: on #mistercop (2.48M messages, 23.6k
// chatters) the message-count curve has no elbow to cut at - the busiest person holds 16.1% of the
// top 10's mass and still 5.4% of the top 100's - and the obvious recognisability proxy does not
// discriminate either: of the top 150, 149 had posted within 90 days AND on 30+ separate days, and
// rank 150 had posted the day before. So the data bounds the pool from below (a dead channel has
// nobody) and says nothing about where the top ends. 50 is a judgement about who a regular viewer
// would recognise, and it is checked by playing, not by querying.
const POOL_SIZE = 50;

// A person needs this many usable lines to be worth asking about. It almost never bites on a live
// channel - after filtering, the top 50 of #mistercop hold thousands of questions each - and
// exists for the degenerate case where somebody's whole history is greetings.
const MIN_QUESTIONS_PER_AUTHOR = 50;

// A channel appears in the picker only with this many qualifying authors. Below it the same faces
// come back every round and four options stop being a choice. #otira_ (54 chatters, 25 messages at
// rank 20) and #meowgumin (93 messages in total) do not clear it; #mistercop does.
const MIN_CHANNEL_AUTHORS = 30;

// ---------------------------------------------------------------------------------------
// Which line may be asked
// ---------------------------------------------------------------------------------------

// Long enough to carry a voice, short enough to read at a glance.
const MAX_LENGTH = 120;

// The rule that decides the whole game, and the one constant here chosen by measurement rather
// than by taste. Three attempts, all on the same random sample of the #mistercop pool:
//
//   "contains a channel emote or a word rarer than 1-in-10000 messages"   passes 95.3%
//   the same at 1-in-100000                                              passes 89.1%
//   ">= 5 significant words" + the rarity clause                         passes 29.6%
//   ">= 5 significant words" alone                                       passes 30.1%
//
// The rarity idea could not work: only 3341 words clear that bar, so nearly every line holds a
// "rare" word. It kept "Грубо но правда ))" and "Как же рубик не попадает ))" - the exact
// unanswerable fragments it was written to remove - and threw away "Илюха - дотер в лесу", which
// is somebody's voice. And the last two lines above are the proof that rarity adds nothing once
// length is required: 29.6 against 30.1.
//
// What separates an answerable line from a coin toss is substance. But WHICH words count decides
// how much substance the number really asks for: counting stopwords, ">= 5" admits "что там у них
// было такое", five words that are all filler. Using extractWords()'s definition instead -
// stopwords, @mentions, commands, links, channel emotes and sub-3-character tokens excluded, and
// repeats of an already-counted word collapsed, so "baz baz baz baz baz baz" is one word and not
// six - the threshold can drop to three and the pool gets BIGGER and cleaner at once: 38.5% of the
// raw pool, ~2724 questions per author. At that setting every dud in the sample goes ("в компах
// хорошо", "я уже смотрел", "Бля Ян хорош") while the short-but-voiced ones stay ("критов нет билд
// хуйня Jokerge", "Хуже тычки мираны нет ничего").
const MIN_CONTENT_WORDS = 3;

const URLISH = /(^|\s)(https?:\/\/|www\.)|\.(com|ru|org|net|io|tv|gg|me|xyz|co|dev)(\/|\s|$)/i;

// ---------------------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------------------

const ROUNDS = 10;
const OPTIONS = 4;

// Free, revealed by a click: three more lines by the same author, so the player can compare a
// voice instead of recalling a person. Drawn from the strict pool - a hint that is itself a shrug
// teaches nothing.
const HINTS = 3;

// Two rounds in ten come from the lines MIN_CONTENT_WORDS rejects. The strict rule is a filter on
// a distribution, not a definition of a good question, and it does throw away real ones; the
// admixture is what keeps a run from tasting uniformly of the filter. Deliberately not marked
// during play - a question labelled "this one is a lottery" is a question nobody thinks about -
// but named in the end-of-run breakdown, where it explains a miss.
const LOOSE_ROUNDS = 2;

// Lines shown around the message when the player opens the context, and the name put in place of
// the author's everywhere it appears - as a sender AND inside anyone's text, because "@login да
// ладно" three lines down is the answer printed in full.
const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 5;
const AUTHOR_PLACEHOLDER = "ЗАГАДОЧНАЯ ЛИЧНОСТЬ";

function hasLink(text) {
  return URLISH.test(String(text || ""));
}

function isCommand(text) {
  return /^\s*[!#]/.test(String(text || ""));
}

// Rules that hold for every question, strict or admixed: it has to be a chat line rather than a
// command or a link dump, and it has to fit on a card.
function isUsableLine(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_LENGTH) return false;
  if (isCommand(trimmed)) return false;
  if (hasLink(trimmed)) return false;
  return true;
}

// Whether a usable line also carries enough of its author to be worth guessing at.
function isStrictLine(text, isEmote = () => false) {
  return extractWords(text, isEmote).length >= MIN_CONTENT_WORDS;
}

// Two lines with the same key are the same question, and a question two people have asked has two
// right answers - so the pool keeps neither. Case and spacing only, via the project's existing
// key: folding further (homoglyphs, stemming) would merge lines that are genuinely different.
function questionKey(text) {
  return aiTextKey(text);
}

function isChannelPlayable(authorCount) {
  return authorCount >= MIN_CHANNEL_AUTHORS;
}

// ---------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------

function shuffle(items, rng = Math.random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sample(items, n, rng = Math.random) {
  return shuffle(items, rng).slice(0, Math.max(0, n));
}

// The four logins under a question: its author plus three others from the pool.
//
// Anyone the line @-mentions is barred from the decoys. Mentions stay in the text - they are how
// this chat actually talks - and the cost of that is precise: a message addressed to someone is a
// message that person did not write, so an addressee among the options is a free elimination, one
// in four becoming one in three for a reason that has nothing to do with knowing the chat.
function pickOptions(pool, authorId, text, rng = Math.random) {
  const author = pool.find((p) => p.userId === authorId);
  if (!author) return null;

  const barred = new Set(extractMentions(text));
  const decoys = pool.filter(
    (p) => p.userId !== authorId && !barred.has(String(p.login || "").toLowerCase())
  );
  if (decoys.length < OPTIONS - 1) return null;

  return shuffle([author, ...sample(decoys, OPTIONS - 1, rng)], rng);
}

// The ten questions of a run: LOOSE_ROUNDS from the lines the strict rule rejected, the rest from
// the ones it kept, then shuffled so the admixed ones are not simply the last two.
//
// The draw is over QUESTIONS, not authors - a busy author owns more lines and so comes up more
// often, which is the honest shape of who talks in this chat. Repeats of an author inside one run
// are allowed for the same reason.
function pickRunQuestions(strict, loose, rng = Math.random) {
  const wantLoose = Math.min(LOOSE_ROUNDS, loose.length);
  const wantStrict = Math.min(ROUNDS - wantLoose, strict.length);
  const picked = [
    ...sample(strict, wantStrict, rng).map((q) => ({ ...q, admixed: false })),
    ...sample(loose, wantLoose, rng).map((q) => ({ ...q, admixed: true })),
  ];
  return shuffle(picked, rng);
}

// Three other lines by the same author, never the question itself.
function pickHints(authorLines, questionId, rng = Math.random) {
  const others = authorLines.filter((q) => String(q._id) !== String(questionId));
  return sample(others, HINTS, rng);
}

// Every appearance of the author's login - as a sender name and inside anybody's text - becomes
// the placeholder. Not anchored to word boundaries on purpose: "@login," and "login-у" must both
// be caught, and a missed one is the answer in plain sight.
function maskAuthor(text, login) {
  const name = String(login || "");
  if (!name) return String(text || "");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "").replace(new RegExp(escaped, "gi"), AUTHOR_PLACEHOLDER);
}

module.exports = {
  POOL_SIZE,
  MIN_QUESTIONS_PER_AUTHOR,
  MIN_CHANNEL_AUTHORS,
  MAX_LENGTH,
  MIN_CONTENT_WORDS,
  ROUNDS,
  OPTIONS,
  HINTS,
  LOOSE_ROUNDS,
  CONTEXT_BEFORE,
  CONTEXT_AFTER,
  AUTHOR_PLACEHOLDER,
  hasLink,
  isCommand,
  isUsableLine,
  isStrictLine,
  questionKey,
  isChannelPlayable,
  shuffle,
  sample,
  pickOptions,
  pickRunQuestions,
  pickHints,
  maskAuthor,
};
