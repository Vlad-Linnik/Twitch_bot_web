// Twitch's own categories - the game section's first tab. The name a game was streamed under is the
// one that ties its card to the bot's samples (hours on stream), and Twitch knows Russian names as
// well as English ones. Box art comes from static-cdn.jtvnw.net in Twitch's 3:4.
//
// Helix with the site's app token (twitch/appToken.js), passed in as `getToken` so this module stays
// testable without the network. Same rules as the other sources: no redirects, a timeout, "nothing
// found" is a normal answer.
const { getJson, str } = require("./http");

const HELIX = "https://api.twitch.tv/helix";

// Helix returns box art as a template ("…-{width}x{height}.jpg") on Get Games and as an already-sized
// file ("…-52x72.jpg") on Search Categories; both are sized here.
function sizeBoxArt(url, width, height) {
  if (typeof url !== "string" || !url) return null;
  if (url.includes("{width}")) return url.replace("{width}", String(width)).replace("{height}", String(height));
  return url.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, `-${width}x${height}$1`);
}

function normalize(g) {
  if (!g || !/^\d{1,12}$/.test(String(g.id || ""))) return null;
  const title = str(g.name);
  if (!title) return null;
  return {
    ref: `twitch:${g.id}`,
    source: "twitch",
    title,
    originalTitle: null,
    year: null,
    mediaType: null,
    previewUrl: sizeBoxArt(g.box_art_url, 52, 69),
    posterUrl: sizeBoxArt(g.box_art_url, 600, 800),
    imdbId: null,
    episodes: null,
    nsfwHint: false,
    external: { twitchCategoryId: String(g.id), twitchCategoryName: title },
  };
}

function createTwitchCategorySource({ getToken, clientId, fetchImpl } = {}) {
  async function helix(path) {
    if (!clientId || typeof getToken !== "function") return [];
    const token = await getToken();
    const body = await getJson(`${HELIX}${path}`, { fetchImpl, headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId } });
    return Array.isArray(body.data) ? body.data : [];
  }
  return {
    key: "twitch",
    async search(query) {
      return (await helix(`/search/categories?query=${encodeURIComponent(query)}&first=10`)).map(normalize).filter(Boolean);
    },
    async details(id) {
      if (!/^\d{1,12}$/.test(String(id))) return null;
      const [game] = await helix(`/games?id=${id}`);
      return normalize(game);
    },
  };
}

module.exports = { createTwitchCategorySource, normalize, sizeBoxArt };
