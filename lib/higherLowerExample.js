// Which real chat line may stand under a word on a "Выше — ниже" card, and which of two lines is
// the better one. Pure, so tests/higherLowerExample.test.js can cover it without Mongo; the scan
// that applies it is jobs/higherLowerExamples.js.
//
// The genre's usual reference puts a photograph behind each item. A chat word has no photograph,
// and the first attempt at this - looking a line up per round with a regex - was abandoned after
// measuring: `messages` carries no text index, so one lookup cost between 65ms and 10.4s and
// sometimes found nothing at all. Hence a precomputed line per word, and hence these rules, which
// are what makes a precomputed line worth showing.

// Long enough to be a sentence, short enough to sit under a word without taking over the card.
const MAX_LENGTH = 120;

// A line with this many words is a scene; below it, it is a fragment. Used only to prefer one
// candidate over another - a two-word line is still allowed when nothing better exists.
const TOKENS_ENOUGH = 4;

const MIN_TOKENS = 2;

// A line with a link in it shows the word in no better light than one without, and it puts a
// stranger's URL on a public page for as long as the example stands. The word tokenizer already
// drops URL tokens from the counts (lib/textStats.js's looksLikeUrl); this drops the whole message
// from consideration as an example, which is the same judgement applied to the sentence.
const URLISH = /(^|\s)(https?:\/\/|www\.)|\.(com|ru|org|net|io|tv|gg|me|xyz|co|dev)(\/|\s|$)/i;

function tokenCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function hasLink(text) {
  return URLISH.test(String(text || ""));
}

// The rule that matters: the message has to say more than the word itself. Length alone is not
// enough - "позиция" as a whole message is one character shorter than "позиция." and both are
// useless as an example - so a second token is required as well.
function isUsable(text, word) {
  const trimmed = String(text || "").trim();
  if (!trimmed || !word) return false;
  if (trimmed.length <= String(word).length) return false;
  if (trimmed.length > MAX_LENGTH) return false;
  if (hasLink(trimmed)) return false;
  return tokenCount(trimmed) >= MIN_TOKENS;
}

// Keeps the first usable line found, then upgrades once if a fuller one turns up. Deliberately
// not "always keep the longest": the scan visits ~2M messages and every replacement is a string
// kept in memory for the rest of it, so this settles as soon as the line is good enough.
function isBetter(candidateText, currentText) {
  if (!currentText) return true;
  return tokenCount(currentText) < TOKENS_ENOUGH && tokenCount(candidateText) >= TOKENS_ENOUGH;
}

module.exports = { isUsable, isBetter, tokenCount, hasLink, MAX_LENGTH, MIN_TOKENS, TOKENS_ENOUGH };
