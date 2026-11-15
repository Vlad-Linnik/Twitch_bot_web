// /:channel/games - games played on stream. Everything the section does is the shared media core
// (routes/mediaSection.js); this file is what makes it about games. (routes/games.js is the site's
// own games - a different thing that happens to share the word.)
//   - search: Twitch categories first (the name the game was streamed under, Russian included),
//     Steam second (store link, art, review score) - lib/mediaSources/;
//   - the form's own fields: where the channel is with it (playing / completed / dropped), the
//     Steam app id or store link, the Twitch category - no film type, no episodes, no IMDb;
//   - hours on stream and "last played", from the bot's 5-minute samples (db/streamHoursRepo.js),
//     computed per request and usable as a sort; the editor's form lists the categories that were on
//     stream with no card yet;
//   - the outside rating: Steam's share of positive reviews, once a day and soon after a card gets a
//     new Steam app (jobs/steamReviewsSync.js; SteamSpy when the store refuses this network);
//   - the look: cyan on cold slate, 3:4 box art (the "games" theme in public/css/input.css).
const media = require("../lib/mediaValidation");
const suggestions = require("../lib/mediaSuggestions");
const { createGameSources } = require("../lib/mediaSources");
const steam = require("../lib/mediaSources/steam");
const { categoryKey, playedWithoutCard } = require("../lib/streamHours");
const streamHoursRepo = require("../db/streamHoursRepo");
const mediaItemsRepo = require("../db/mediaItemsRepo");
const { ensureAppAccessToken } = require("../twitch/appToken");
const env = require("../config/env");
const { createMediaSectionRouter } = require("./mediaSection");
const steamReviewsSync = require("../jobs/steamReviewsSync");

// The card's ids: the Steam app (typed or picked), the Twitch category (its id only from a pick -
// the server-side details - and its name from the form or the pick).
function externalIds(value, picked) {
  const external = {};
  const steamAppId = value.steamAppId || picked?.external?.steamAppId || null;
  if (steamAppId) external.steamAppId = steamAppId;
  if (picked?.external?.twitchCategoryId) external.twitchCategoryId = picked.external.twitchCategoryId;
  const name = value.twitchCategoryName || picked?.external?.twitchCategoryName || null;
  if (name) external.twitchCategoryName = name;
  return external;
}

const twitchDirectoryUrl = (name) => `https://www.twitch.tv/directory/category/${encodeURIComponent(name)}`;

module.exports = createMediaSectionRouter({
  section: "games",
  kind: "game",
  sources: createGameSources({ twitch: { getToken: ensureAppAccessToken, clientId: env.twitchClientId } }),
  sorts: ["added", "hours", "streamer", "viewers", "steam", "comments", "score"],
  view: {
    path: "games",
    i18n: "gamesStream",
    theme: "games",
    attribution: "games",
    defaultMediaType: null,
    posterSource: "steam",
    fields: { mediaType: false, progress: false, imdbId: false, gameState: true, steam: true, twitchCategory: true },
  },
  parseForm: (body, opts) => media.parseMediaForm(body, { ...opts, kind: "game" }),
  parseSuggestionForm: (body) => suggestions.parseSuggestionForm(body, { kind: "game" }),
  formValues: (item) => ({
    steamAppId: item.external?.steamAppId || "",
    twitchCategoryName: item.external?.twitchCategoryName || "",
    gameState: item.gameState || "",
  }),
  externalIds,
  // A card with a Steam app but no score yet: ask for an early pass instead of leaving it at "—"
  // until the daily one - the same as a film with a new IMDb id.
  afterSave(item) {
    if (item?.external?.steamAppId && !item.ratings?.external) steamReviewsSync.requestSoon();
  },
  editSet(value, item, picked) {
    const ids = externalIds(value, picked);
    const set = {
      gameState: value.gameState,
      "external.steamAppId": ids.steamAppId ?? null,
      "external.twitchCategoryName": ids.twitchCategoryName ?? null,
    };
    // A different Steam app makes the stored Steam score another game's; the daily pass fills it in.
    if ((ids.steamAppId || null) !== (item.external?.steamAppId || null)) set["ratings.external"] = null;
    // The category id follows the name: a new pick brings its id, a hand-edited name drops the old one.
    if (picked?.external?.twitchCategoryId) set["external.twitchCategoryId"] = picked.external.twitchCategoryId;
    else if (categoryKey(ids.twitchCategoryName) !== categoryKey(item.external?.twitchCategoryName)) set["external.twitchCategoryId"] = null;
    return set;
  },
  // The cover, in order: Steam's vertical library art (built from the numeric app id), the picked
  // Twitch box art, Steam's wide header as the last resort. The first one that downloads wins.
  posterUrlsFor(value, picked) {
    const appId = value.steamAppId || picked?.external?.steamAppId || null;
    const urls = [];
    if (appId) urls.push({ url: steam.libraryArtUrl(appId), source: "steam" });
    if (picked?.source === "twitch" && picked.posterUrl) urls.push({ url: picked.posterUrl, source: "twitch" });
    if (appId) urls.push({ url: steam.headerArtUrl(appId), source: "steam" });
    return urls;
  },
  // A different Steam app on an edit: the cover built from the old one shows another game.
  posterOutdated: (value, item) => Boolean(value.steamAppId) && value.steamAppId !== (item.external?.steamAppId || null),
  // Hours on stream per card, from the channel's samples - also the "hours" sort key.
  async decorateRows(channel, rows) {
    const index = await streamHoursRepo.hoursIndex(channel.channelId).catch(() => new Map());
    return rows.map((row) => {
      const hit = index.get(categoryKey(row.external?.twitchCategoryName));
      return hit ? { ...row, streamMinutes: hit.minutes, streamLastSeen: hit.lastSeen } : row;
    });
  },
  cardExtras(item) {
    const links = [];
    if (item.external?.steamAppId) links.push({ href: steam.storeUrl(item.external.steamAppId), label: "Steam" });
    if (item.external?.twitchCategoryName) links.push({ href: twitchDirectoryUrl(item.external.twitchCategoryName), label: "Twitch" });
    return { minutes: item.streamMinutes || 0, lastSeen: item.streamLastSeen || null, gameState: item.gameState || null, links };
  },
  // "Played on stream, no card yet" - the editor's quick picks on the new-card form.
  async formExtras(channel) {
    const [index, cards] = await Promise.all([
      streamHoursRepo.hoursIndex(channel.channelId).catch(() => new Map()),
      mediaItemsRepo.listForDuplicateCheck(channel.channelLogin, "game"),
    ]);
    return { playedWithoutCard: playedWithoutCard(index, cards) };
  },
  // /games/new?category=<name> - a quick pick lands here with the title and category filled in.
  prefill(query) {
    const name = media.parseTwitchCategory(query.category).value;
    return name ? { title: name, twitchCategoryName: name } : {};
  },
});
