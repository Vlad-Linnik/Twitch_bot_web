// Where movie and game posters may come from - one list read by both the Content-Security-Policy
// (app.js's img-src, for the previews in the editor's search dropdown) and the server-side poster
// download (lib/remoteImage.js via routes/movies.js). Same reasoning as lib/emoteImageHosts.js: a
// host that is in one and not the other fails silently on one side.
//
// The widening of img-src only covers the dropdown's previews, i.e. someone else's pictures before
// a card is saved. A saved card always references its own copy under /uploads/media/
// (lib/mediaImage.js) - never one of these hosts - so a source moving its CDN never breaks a card.
//
// Origins, not prefixes: "https://image.tmdb.org.evil.example" must not pass.
const MEDIA_IMAGE_ORIGINS = Object.freeze([
  // TMDB's image CDN (search results and details both point here).
  "https://image.tmdb.org",
  // IMDb's posters, as the no-key IMDb suggestion fallback returns them.
  "https://m.media-amazon.com",
  // Shikimori serves its covers from the API host itself. The host moved once already
  // (shikimori.one -> shikimori.io, a 301), which is why every hop of a download is re-checked.
  "https://shikimori.io",
]);
const ORIGIN_SET = new Set(MEDIA_IMAGE_ORIGINS);

function isAllowedMediaImageUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  return ORIGIN_SET.has(parsed.origin);
}

module.exports = { MEDIA_IMAGE_ORIGINS, isAllowedMediaImageUrl };
