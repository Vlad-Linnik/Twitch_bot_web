// A GameScores `game` value is a LEADERBOARD key, not a game identity, and for one game the two
// differ. "Выше — ниже" keeps a separate board per (mode, channel) - a score on #mistercop's
// emotes says nothing about a score on another channel's words, so they cannot share a ranking -
// which means it writes keys like "higher-lower-emotes-mistercop". Everything that asks "which
// game is this" (the admin panel's per-game figures) must fold those back, or one game reports
// itself as 2xN unnamed games whose player counts never line up with its single session counter.
//
// Kept as a table rather than a regex so the fold is a list of known prefixes: a key that merely
// starts with a game's id is not automatically that game's board, and a new composite key has to
// be added here deliberately.
const COMPOSITE_SCORE_KEYS = [{ prefix: "higher-lower-", gameId: "higher-lower" }];

const HIGHER_LOWER_SCORE_PREFIX = "higher-lower-";

// The inverse of whatever built the key. Any key not in the table is already a game id.
function gameIdFromScoreKey(key) {
  const match = COMPOSITE_SCORE_KEYS.find((entry) => String(key).startsWith(entry.prefix));
  return match ? match.gameId : key;
}

module.exports = { COMPOSITE_SCORE_KEYS, HIGHER_LOWER_SCORE_PREFIX, gameIdFromScoreKey };
