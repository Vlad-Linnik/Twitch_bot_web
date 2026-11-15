// What a game card's page and the games grid know about the game itself - genres, community tags
// and a short description - stored as the card's `info` block (lib/mediaInfo.js), the same block a
// film gets from TMDB/Shikimori. Filled for every card with a Steam app id by the daily Steam pass
// (jobs/steamReviewsSync.js), not on page view: the grid's genre/tag filter and search read it for
// cards nobody has opened.
//
// Two sources, each optional:
//   - the store's appdetails (Russian): the genres as Steam names them on its own pages ("Ролевые
//     игры", "Инди") and the short description. Answers the development machine, unlike the
//     store's appreviews endpoint (lib/steamReviews.js), but a refusal is handled the same way.
//   - SteamSpy's appdetails: the community tags (Open World, Roguelike, Souls-like...) - the store's
//     API has no tags at all - and its own English genre list, used only when the store did not
//     answer. Tags are English: SteamSpy has no other language, and they are the words players use.
// A card whose two sources both had nothing gets no block and is asked again on the next pass.
const { getJson, SourceError } = require("./mediaSources/http");
const { cleanInfo } = require("./mediaInfo");

const REFUSED = /status (3\d\d|403|429)/;
const isRefusal = (err) => err instanceof SourceError && REFUSED.test(err.message);

// The handful of entities Steam's short_description actually carries.
function decodeEntities(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Tags by votes, most voted first (SteamSpy sends {name: votes}).
function tagsFromSteamSpy(body) {
  const tags = body && typeof body.tags === "object" && !Array.isArray(body.tags) ? body.tags : {};
  return Object.entries(tags)
    .filter(([name, votes]) => typeof name === "string" && Number(votes) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([name]) => name);
}

const genresFromSteamSpy = (body) =>
  typeof body?.genre === "string" ? body.genre.split(",").map((g) => g.trim()).filter(Boolean) : [];

// The store's appdetails -> {genres, overview}, or null when it has no such app.
function fromStore(body, appId) {
  const entry = body && body[String(appId)];
  if (!entry || !entry.success || !entry.data) return null;
  const data = entry.data;
  return {
    genres: (Array.isArray(data.genres) ? data.genres : []).map((g) => g && g.description).filter(Boolean),
    overview: data.short_description ? decodeEntities(data.short_description) : null,
  };
}

/**
 * @returns {Promise<{info: object|null, refused: {store: boolean, steamspy: boolean}}>}
 */
async function fetchGameInfo(appId, { fetchImpl, now = new Date() } = {}) {
  const refused = { store: false, steamspy: false };
  let store = null;
  let spy = null;
  try {
    store = fromStore(await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=russian&cc=US`, { fetchImpl }), appId);
  } catch (err) {
    refused.store = isRefusal(err);
  }
  try {
    spy = await getJson(`https://steamspy.com/api.php?request=appdetails&appid=${appId}`, { fetchImpl });
  } catch (err) {
    refused.steamspy = isRefusal(err);
  }
  const genres = store && store.genres.length ? store.genres : genresFromSteamSpy(spy);
  const info = cleanInfo({ genres, tags: tagsFromSteamSpy(spy), overview: store ? store.overview : null }, now);
  return { info, refused };
}

module.exports = { fetchGameInfo, tagsFromSteamSpy, genresFromSteamSpy, fromStore, decodeEntities };
