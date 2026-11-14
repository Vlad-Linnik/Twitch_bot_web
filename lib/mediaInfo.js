// What a movie card's own page says about the film itself - genres, director, cast, the synopsis -
// as one small block stored on the card (`MediaItems.info`). It comes from the search source's
// answer (TMDB or Shikimori, lib/mediaSources/), never from the form, and is plain text: the page
// escapes it like any other string.
//
// Stored rather than asked for on every view: the sources are other people's services with their
// own limits and outages, and the page must not wait on them. A card saved before this block
// existed gets it the first time its page is opened (routes/mediaSection.js).
//
// {v, genres: string[], directors: string[], cast: string[], castKind: 'actors'|'characters',
//  overview: string|null, runtime: minutes|null, ageRating: "16+" | "PG-13" | null, fetchedAt: Date}
//
// `v` is the shape's version. A field added later (ageRating came after the rest) only reaches
// cards saved before it if they are asked again, so a block older than INFO_VERSION is refetched
// on the next page view exactly like a missing one.
const INFO_VERSION = 2;
const LIMITS = { genres: 6, directors: 3, cast: 8, name: 60, overview: 1500 };

const text = (v, max) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

// Unique non-empty names, in the source's order, capped.
function names(list, cap) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = text(v, LIMITS.name);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

// Shikimori's synopsis carries its own markup ("[character=40881]Микаса[/character]",
// "[url=...]", "[i]"): the tags go, the words inside them stay.
function stripBbcode(s) {
  return typeof s === "string" ? s.replace(/\[\/?[a-z_]+(?:=[^\]]*)?\]/gi, "") : s;
}

// An age rating as the source prints it: Russia's "16+" when the source has one, else the US
// rating ("PG-13", "TV-MA") or Shikimori's ("R-17"). Short and of a known alphabet, or nothing.
const ageRatingOf = (v) => (typeof v === "string" && /^[\w+-]{1,10}$/.test(v.trim()) ? v.trim() : null);

// A source's raw fields -> the stored block, or null when there is nothing worth showing.
function cleanInfo(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return null;
  let overview = text(stripBbcode(raw.overview), LIMITS.overview + 1);
  if (overview && overview.length > LIMITS.overview) overview = overview.slice(0, LIMITS.overview - 1).trimEnd() + "…";
  const info = {
    genres: names(raw.genres, LIMITS.genres),
    directors: names(raw.directors, LIMITS.directors),
    cast: names(raw.cast, LIMITS.cast),
    castKind: raw.castKind === "characters" ? "characters" : "actors",
    overview,
    runtime: Number.isInteger(raw.runtime) && raw.runtime > 0 && raw.runtime < 2000 ? raw.runtime : null,
    ageRating: ageRatingOf(raw.ageRating),
  };
  const empty = !info.genres.length && !info.directors.length && !info.cast.length && !info.overview && !info.runtime && !info.ageRating;
  return empty ? null : { v: INFO_VERSION, ...info, fetchedAt: now };
}

// Whether a card's stored block should be asked for again: never asked (absent), or asked under
// an older shape. A null block means the source had nothing - asked, answered, done.
function infoIsStale(info) {
  if (info === undefined) return true;
  return Boolean(info) && info.v !== INFO_VERSION;
}

// The ref a card's info can be asked for by: the search source's own id, which only the server
// ever wrote (routes/movies.js's externalIds). An IMDb-only card has none - the no-key IMDb
// fallback knows nothing beyond the title.
function infoRefOf(external) {
  if (!external) return null;
  if (Number.isInteger(external.tmdbId) && (external.tmdbType === "movie" || external.tmdbType === "tv")) {
    return `tmdb:${external.tmdbType}:${external.tmdbId}`;
  }
  if (Number.isInteger(external.shikimoriId)) return `shikimori:${external.shikimoriId}`;
  return null;
}

module.exports = { cleanInfo, infoRefOf, infoIsStale, stripBbcode, LIMITS, INFO_VERSION };
