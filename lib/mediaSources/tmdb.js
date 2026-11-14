// TMDB - the main search for films and series: Russian title and overview with language=ru-RU,
// posters, episode counts, and the IMDb id (which ties a card to the nightly IMDb rating).
//
// Auth is the v4 "API Read Access Token" as a Bearer header - never an api_key query parameter,
// which would put the secret in every log line that records a URL. Free, non-commercial use, with
// the attribution shown under the section (views/partials/mediaAttribution.ejs).
const { getJson, yearOf, str } = require("./http");
const { cleanInfo } = require("../mediaInfo");

const API = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const PREVIEW_SIZE = "w92";
const POSTER_SIZE = "w500";
const ANIMATION_GENRE = 16;

// TMDB has no "anime" type: an animated title of Japanese origin is the working definition.
function mediaTypeOf(kind, { genreIds = [], originCountry = [], originalLanguage = null }) {
  const animated = genreIds.includes(ANIMATION_GENRE);
  const japanese = originalLanguage === "ja" || originCountry.includes("JP");
  if (animated && japanese) return "anime";
  return kind === "tv" ? "series" : "film";
}

const imageUrl = (path, size) => (typeof path === "string" && /^\/[\w.-]+\.(jpe?g|png|webp)$/i.test(path) ? `${IMAGE_BASE}/${size}${path}` : null);

function normalizeSearchResult(r) {
  if (r.media_type !== "movie" && r.media_type !== "tv") return null;
  const isTv = r.media_type === "tv";
  const title = str(isTv ? r.name : r.title) || str(isTv ? r.original_name : r.original_title);
  if (!title || !Number.isInteger(r.id)) return null;
  const original = str(isTv ? r.original_name : r.original_title);
  return {
    ref: `tmdb:${r.media_type}:${r.id}`,
    source: "tmdb",
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(isTv ? r.first_air_date : r.release_date),
    mediaType: mediaTypeOf(r.media_type, { genreIds: r.genre_ids || [], originCountry: r.origin_country || [], originalLanguage: r.original_language }),
    previewUrl: imageUrl(r.poster_path, PREVIEW_SIZE),
  };
}

function normalizeDetails(kind, d) {
  const isTv = kind === "tv";
  const title = str(isTv ? d.name : d.title) || str(isTv ? d.original_name : d.original_title);
  const original = str(isTv ? d.original_name : d.original_title);
  const imdbId = str(d.external_ids?.imdb_id) || str(d.imdb_id);
  const episodes = isTv && Number.isInteger(d.number_of_episodes) && d.number_of_episodes > 0 ? d.number_of_episodes : null;
  return {
    ref: `tmdb:${kind}:${d.id}`,
    source: "tmdb",
    title,
    originalTitle: original && original !== title ? original : null,
    year: yearOf(isTv ? d.first_air_date : d.release_date),
    mediaType: mediaTypeOf(kind, {
      genreIds: (d.genres || []).map((g) => g.id),
      originCountry: d.origin_country || [],
      originalLanguage: d.original_language,
    }),
    imdbId: imdbId && /^tt\d{7,10}$/.test(imdbId) ? imdbId : null,
    episodes,
    posterUrl: imageUrl(d.poster_path, POSTER_SIZE),
    // A hint the editor confirms, not a decision: TMDB's `adult` flag.
    nsfwHint: d.adult === true,
    external: { tmdbId: d.id, tmdbType: kind },
    info: cleanInfo(infoOf(kind, d)),
  };
}

// The age rating, Russia's first ("16+"), the US one when Russia has none. A film's sits in
// release_dates (one per release - the first non-empty one counts), a series' in content_ratings.
function ageRatingOf(kind, d) {
  const forCountry = (code) => {
    if (kind === "tv") {
      const hit = (d.content_ratings?.results || []).find((r) => r.iso_3166_1 === code);
      return str(hit?.rating);
    }
    const hit = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === code);
    return (hit?.release_dates || []).map((r) => str(r.certification)).find(Boolean) || null;
  };
  return forCountry("RU") || forCountry("US");
}

// Genres, director, cast and synopsis from the same answer (credits ride along via
// append_to_response). A film has one credits list; a series has `aggregate_credits`, where every
// episode's director is listed - the show's own authors are `created_by`, and failing those the
// directors of the most episodes stand for it.
function infoOf(kind, d) {
  const isTv = kind === "tv";
  const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999);
  let directors;
  let cast;
  if (isTv) {
    const credits = d.aggregate_credits || {};
    directors = (d.created_by || []).map((p) => p.name);
    if (!directors.length) {
      directors = (credits.crew || [])
        .filter((c) => (c.jobs || []).some((j) => j.job === "Director"))
        .sort((a, b) => (b.total_episode_count || 0) - (a.total_episode_count || 0))
        .map((c) => c.name);
    }
    cast = [...(credits.cast || [])].sort(byOrder).map((c) => c.name);
  } else {
    const credits = d.credits || {};
    directors = (credits.crew || []).filter((c) => c.job === "Director").map((c) => c.name);
    cast = [...(credits.cast || [])].sort(byOrder).map((c) => c.name);
  }
  return {
    genres: (d.genres || []).map((g) => g.name),
    directors,
    cast,
    castKind: "actors",
    overview: d.overview,
    runtime: isTv ? null : d.runtime,
    ageRating: ageRatingOf(kind, d),
  };
}

function createTmdbSource({ token, fetchImpl } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    key: "tmdb",
    async search(query) {
      const url = `${API}/search/multi?query=${encodeURIComponent(query)}&language=ru-RU&include_adult=false&page=1`;
      const body = await getJson(url, { headers, fetchImpl });
      return (body.results || []).map(normalizeSearchResult).filter(Boolean).slice(0, 12);
    },
    // id: "movie:27205" | "tv:1396"
    async details(id) {
      const m = String(id).match(/^(movie|tv):(\d{1,10})$/);
      if (!m) return null;
      const url = `${API}/${m[1]}/${m[2]}?language=ru-RU&append_to_response=external_ids,${m[1] === "tv" ? "aggregate_credits,content_ratings" : "credits,release_dates"}`;
      return normalizeDetails(m[1], await getJson(url, { headers, fetchImpl }));
    },
  };
}

module.exports = { createTmdbSource, normalizeSearchResult, normalizeDetails, mediaTypeOf, infoOf, ageRatingOf };
