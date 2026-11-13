// Steam - the game section's second tab: the store link, the vertical cover and the review score.
// No key. Three things measured on the live store (2026-11-13) shape this module:
//   - the store search understands Latin far better than Cyrillic («ведьмак» found only an editor
//     tool, "the witcher 3" found the game), so the Twitch tab - which knows Russian names - comes
//     first and Steam is searched by the English title;
//   - appdetails depends on the requester's region: without `cc` it answered success:false, with
//     cc=US it returned everything - so `cc` is always sent;
//   - the vertical "library" art (600x900, 2:3) exists for most games and not for old ones, where
//     the wide header.jpg is the fallback. Both URLs are built here from the numeric app id - the
//     server never downloads an address a form posted.
const { getJson, str } = require("./http");

const STORE = "https://store.steampowered.com";
const ART = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps";

// Content descriptors that tick "18+" for the editor to confirm: 3 = adult only sexual content,
// 4 = frequent nudity or sexual content. 1 (some nudity) alone does not - that is half the
// catalogue, The Witcher 3 included, whose cover is entirely ordinary.
const ADULT_DESCRIPTORS = new Set([3, 4]);

const libraryArtUrl = (appId) => `${ART}/${appId}/library_600x900.jpg`;
const headerArtUrl = (appId) => `${ART}/${appId}/header.jpg`;
const storeUrl = (appId) => `${STORE}/app/${appId}/`;

function yearFromSteamDate(text) {
  const m = typeof text === "string" ? text.match(/(19|20)\d{2}/) : null;
  return m ? Number(m[0]) : null;
}

function normalizeSearchResult(x) {
  if (!x || x.type !== "app" || !Number.isInteger(x.id)) return null;
  const title = str(x.name);
  if (!title) return null;
  return { ref: `steam:${x.id}`, source: "steam", title, originalTitle: null, year: null, mediaType: null, previewUrl: str(x.tiny_image) };
}

function normalizeDetails(appId, data) {
  if (!data) return null;
  const title = str(data.name);
  if (!title) return null;
  const descriptors = Array.isArray(data.content_descriptors?.ids) ? data.content_descriptors.ids : [];
  return {
    ref: `steam:${appId}`,
    source: "steam",
    title,
    originalTitle: null,
    year: yearFromSteamDate(data.release_date?.date),
    mediaType: null,
    imdbId: null,
    episodes: null,
    posterUrl: libraryArtUrl(appId),
    posterFallbackUrl: headerArtUrl(appId),
    nsfwHint: descriptors.some((d) => ADULT_DESCRIPTORS.has(d)),
    external: { steamAppId: Number(appId) },
  };
}

function createSteamSource({ fetchImpl } = {}) {
  return {
    key: "steam",
    async search(query) {
      const body = await getJson(`${STORE}/api/storesearch/?term=${encodeURIComponent(query)}&l=russian&cc=US`, { fetchImpl });
      return (body.items || []).map(normalizeSearchResult).filter(Boolean).slice(0, 10);
    },
    async details(id) {
      if (!/^\d{1,9}$/.test(String(id))) return null;
      const body = await getJson(`${STORE}/api/appdetails?appids=${id}&cc=US&l=russian`, { fetchImpl });
      const entry = body[String(id)];
      return entry && entry.success ? normalizeDetails(id, entry.data) : null;
    },
  };
}

module.exports = { createSteamSource, normalizeSearchResult, normalizeDetails, libraryArtUrl, headerArtUrl, storeUrl, ADULT_DESCRIPTORS };
