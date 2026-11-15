// /:channel/movies - films, series and anime watched on stream. Everything the section does is the
// shared media core (routes/mediaSection.js); this file is what makes it about films:
//   - search: TMDB when TMDB_READ_TOKEN is set, else IMDb's suggestion search, plus Shikimori for
//     anime (lib/mediaSources/);
//   - the form's own fields: type (film / series / anime), how much was watched, the IMDb id;
//   - the outside rating: IMDb's, from the official dataset once a day (jobs/imdbRatingsSync.js);
//   - the look: warm black with gold (the "movies" theme in public/css/input.css).
const media = require("../lib/mediaValidation");
const suggestions = require("../lib/mediaSuggestions");
const { createMediaSources } = require("../lib/mediaSources");
const env = require("../config/env");
const { createMediaSectionRouter } = require("./mediaSection");
const { infoRefOf } = require("../lib/mediaInfo");
const imdbRatingsSync = require("../jobs/imdbRatingsSync");

// The card's `external` ids: the IMDb id from the form (typed, or filled from the pick), the search
// source's own id only from the server-side details.
function externalIds(value, picked) {
  const external = {};
  if (value.imdbId) external.imdbId = value.imdbId;
  if (picked?.external?.tmdbId) Object.assign(external, { tmdbId: picked.external.tmdbId, tmdbType: picked.external.tmdbType });
  if (picked?.external?.shikimoriId) external.shikimoriId = picked.external.shikimoriId;
  return external;
}

module.exports = createMediaSectionRouter({
  section: "movies",
  kind: "movie",
  sources: createMediaSources({ tmdbToken: env.tmdbReadToken }),
  sorts: ["added", "streamer", "viewers", "imdb", "comments", "score"],
  view: {
    path: "movies",
    i18n: "movies",
    theme: "movies",
    attribution: "movies",
    defaultMediaType: "film",
    fields: { mediaType: true, progress: true, imdbId: true, gameState: false, steam: false, twitchCategory: false },
  },
  parseForm: (body, opts) => media.parseMediaForm(body, opts),
  parseSuggestionForm: (body) => suggestions.parseSuggestionForm(body),
  formValues: (item) => ({ imdbId: item.external?.imdbId || "" }),
  externalIds,
  // Genres, director, cast and synopsis for a card saved before they were stored.
  infoRef: (item) => infoRefOf(item.external),
  // A card with an IMDb id but no rating yet: ask for an early dataset pass instead of leaving
  // it at "—" until the nightly one.
  afterSave(item) {
    if (item?.external?.imdbId && !item.ratings?.external) imdbRatingsSync.requestSoon();
  },
  editSet(value, item, picked) {
    const set = { "external.imdbId": value.imdbId };
    // A different IMDb id makes the stored IMDb rating someone else's; the nightly pass fills in
    // the new one.
    if ((value.imdbId || null) !== (item.external?.imdbId || null)) set["ratings.external"] = null;
    // A new pick replaces the source ids; no pick leaves them as they were.
    if (picked) {
      const ids = externalIds(value, picked);
      set["external.tmdbId"] = ids.tmdbId ?? null;
      set["external.tmdbType"] = ids.tmdbType ?? null;
      set["external.shikimoriId"] = ids.shikimoriId ?? null;
    }
    return set;
  },
});
