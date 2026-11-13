// Shikimori - the anime tab. Russian titles and episode counts there are more reliable than TMDB's
// for anime, and no key is needed (only an identifying User-Agent). It has no IMDb id; a card that
// should show an IMDb rating gets the id by hand or through the TMDB tab.
//
// The score it shows is MyAnimeList's; it is not stored - the card's external rating is IMDb's.
const { getJson, yearOf, str } = require("./http");

const ORIGIN = "https://shikimori.io";
// Age ratings that tick "18+" for the editor to confirm.
const ADULT_RATINGS = new Set(["rx", "r_plus"]);

// Image paths come back relative ("/system/animes/original/16498.jpg?1711973439"). Only that shape
// is turned into a URL - anything else is dropped rather than resolved against our own host.
function imageUrl(path) {
  return typeof path === "string" && /^\/system\/animes\/[\w/]+\.(jpe?g|png|webp)(\?\d+)?$/i.test(path) ? ORIGIN + path : null;
}

const episodesOf = (a) => (Number.isInteger(a.episodes) && a.episodes > 0 ? a.episodes : null);

function normalizeSearchResult(a) {
  if (!Number.isInteger(a.id)) return null;
  const title = str(a.russian) || str(a.name);
  if (!title) return null;
  const original = str(a.name);
  return {
    ref: `shikimori:${a.id}`,
    source: "shikimori",
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(a.aired_on),
    mediaType: "anime",
    previewUrl: imageUrl(a.image?.x96) || imageUrl(a.image?.preview),
  };
}

function normalizeDetails(a) {
  const base = normalizeSearchResult(a);
  if (!base) return null;
  return {
    ...base,
    imdbId: null,
    episodes: episodesOf(a),
    posterUrl: imageUrl(a.image?.original),
    nsfwHint: ADULT_RATINGS.has(a.rating),
    external: { shikimoriId: a.id },
  };
}

function createShikimoriSource({ fetchImpl } = {}) {
  return {
    key: "shikimori",
    async search(query) {
      const body = await getJson(`${ORIGIN}/api/animes?search=${encodeURIComponent(query)}&limit=12`, { fetchImpl });
      return (Array.isArray(body) ? body : []).map(normalizeSearchResult).filter(Boolean);
    },
    async details(id) {
      if (!/^\d{1,9}$/.test(String(id))) return null;
      return normalizeDetails(await getJson(`${ORIGIN}/api/animes/${id}`, { fetchImpl }));
    },
  };
}

module.exports = { createShikimoriSource, normalizeSearchResult, normalizeDetails };
