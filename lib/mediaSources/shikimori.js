// Shikimori - the anime tab. Russian titles and episode counts there are more reliable than TMDB's
// for anime, and no key is needed (only an identifying User-Agent). It has no IMDb id; a card that
// should show an IMDb rating gets the id by hand or through the TMDB tab.
//
// The score it shows is MyAnimeList's; it is not stored - the card's external rating is IMDb's.
const { getJson, yearOf, str } = require("./http");
const { cleanInfo } = require("../mediaInfo");

const ORIGIN = "https://shikimori.io";
// Age ratings that tick "18+" for the editor to confirm.
const ADULT_RATINGS = new Set(["rx", "r_plus"]);
// Shikimori's age ratings as it prints them itself.
const AGE_LABELS = { g: "G", pg: "PG", pg_13: "PG-13", r: "R-17", r_plus: "R+", rx: "Rx" };

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

// Genres and synopsis come with the anime itself; the director and the main characters are in a
// second request (/roles). Anime is voiced, not acted, and Shikimori names the characters, not the
// voice cast - so the list is of characters and the page labels it so (castKind). A failed /roles
// costs only those two lists.
function infoOf(a, roles = []) {
  const list = Array.isArray(roles) ? roles : [];
  return {
    genres: (a.genres || []).map((g) => str(g.russian) || str(g.name)),
    directors: list.filter((r) => r.person && (r.roles || []).includes("Director")).map((r) => str(r.person.russian) || str(r.person.name)),
    cast: list.filter((r) => r.character && (r.roles || []).includes("Main")).map((r) => str(r.character.russian) || str(r.character.name)),
    castKind: "characters",
    overview: a.description,
    runtime: null,
    ageRating: AGE_LABELS[a.rating] || null,
  };
}

function normalizeDetails(a, roles) {
  const base = normalizeSearchResult(a);
  if (!base) return null;
  return {
    ...base,
    imdbId: null,
    episodes: episodesOf(a),
    posterUrl: imageUrl(a.image?.original),
    nsfwHint: ADULT_RATINGS.has(a.rating),
    external: { shikimoriId: a.id },
    info: cleanInfo(infoOf(a, roles)),
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
      const [anime, roles] = await Promise.all([
        getJson(`${ORIGIN}/api/animes/${id}`, { fetchImpl }),
        getJson(`${ORIGIN}/api/animes/${id}/roles`, { fetchImpl }).catch(() => []),
      ]);
      return normalizeDetails(anime, roles);
    },
  };
}

module.exports = { createShikimoriSource, normalizeSearchResult, normalizeDetails, infoOf };
