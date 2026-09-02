// The one leaderboard shape every on-site game renders: top 10 rows, plus the visitor's own row
// with its real rank when they are logged in and ranked below them (the view draws that as an
// 11th line). Names and chat colors come from the profile cache, same as the stats pages.
//
// Extracted from routes/games.js once routes/higherLower.js needed the identical read - a second
// hand-written copy would have drifted the moment either page changed what a row carries.
const gameScoresRepo = require("./gameScoresRepo");
const profileCacheRepo = require("./profileCacheRepo");

const TOP_LIMIT = 10;

async function buildLeaderboard(game, userId) {
  const top = await gameScoresRepo.getTop(game, TOP_LIMIT);
  const me = userId ? await gameScoresRepo.getUserBestAndRank(game, userId) : null;

  const ids = top.map((row) => row.userId);
  if (userId) ids.push(String(userId));
  const profiles = await profileCacheRepo.getOrFetchProfiles(ids);

  const nameOf = (id) => {
    const profile = profiles.get(String(id));
    return {
      displayName: (profile && profile.displayName) || "…",
      color: (profile && profile.chatColor) || null,
    };
  };

  const rows = top.map((row, i) => ({
    rank: i + 1,
    score: row.bestScore,
    isMe: userId != null && row.userId === String(userId),
    ...nameOf(row.userId),
  }));

  let myRow = null;
  if (me && !rows.some((row) => row.isMe)) {
    myRow = { rank: me.rank, score: me.bestScore, ...nameOf(userId) };
  }
  return { rows, myRow };
}

module.exports = { buildLeaderboard, TOP_LIMIT };
