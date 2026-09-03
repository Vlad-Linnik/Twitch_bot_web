// How a player's thumb changes how often a thing is shown again. Shared by the two games on this
// site that let people rate what they are dealt - "Выше — ниже" (lib/higherLower.js) and "Угадай
// чатера" (lib/guessChatter.js).
//
// One curve for both, because both answer the same question - should this keep turning up - and a
// second curve would be a second explanation to keep in step. What differs between the games is
// only WHAT is thinned out: a word and the sentence quoted under it there, a question and a hint
// here. This module is the reason that is a fact about the site rather than a coincidence.
//
// A like does NOT push anything above the ordinary chance. It cancels dislikes and nothing more.
// The alternative, letting likes multiply, hands a handful of enthusiasts the ability to flood
// every run with their favourites, and there is no competing pressure to balance it: nobody
// dislikes a thing for being too common.

// Net score at which something stops appearing entirely. Far enough down that a couple of grumpy
// players cannot delete a word - or a chat line - from the game between them.
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

module.exports = { VOTE_EXCLUDE_AT, weightFor, passesVote };
