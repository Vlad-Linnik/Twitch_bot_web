// Pure rules behind a channel's movie (and later game) cards - routes/movies.js and
// db/mediaItemsRepo.js. Everything here is testable without a database: form parsing, the
// search key, the recording-link allowlist, progress, ratings and the viewer average.
const { renderBody } = require("./newsValidation");
const { MAX_CATEGORY_LENGTH } = require("./commandValidation");

const MEDIA_TYPES = ["film", "series", "anime"];
// A game card has no film type and no episode count; it has where the channel is with it.
// What a card can be created or moved to by the channel (levels 0-2). `suggested` and `rejected`
// belong to viewer suggestions, which have their own flow.
const EDITOR_STATUSES = ["done", "accepted"];
const LIMITS = {
  title: 200,
  originalTitle: 200,
  review: 20000,
  excerpt: 200,
  episodes: 5000,
};
const MIN_YEAR = 1870;
const RATING_MIN = 1;
const RATING_MAX = 10;

// --- text ---------------------------------------------------------------------------------

function cleanLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Lower case, ё -> е, runs of whitespace collapsed. Applied to both the stored key and the
// visitor's query, so "Ёлки" finds "елки" and a double space in either never matters.
function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

// Stored on the card: both titles in one string, so one substring test covers either. The
// separator cannot occur in a normalized title (control characters are stripped on input), so a
// query can never match across the boundary.
function buildSearchKey(title, originalTitle) {
  return [title, originalTitle].map(normalizeSearchText).filter(Boolean).join("\u0001");
}

function matchesSearch(searchKey, query) {
  const q = normalizeSearchText(query);
  return q === "" || String(searchKey || "").includes(q);
}

// --- fields -------------------------------------------------------------------------------

function parseYear(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_YEAR || n > now.getFullYear() + 5) return { error: "year_invalid" };
  return { value: n };
}

function parseRating(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < RATING_MIN || n > RATING_MAX) return { error: "rating_invalid" };
  return { value: n };
}

// "tt1375666", or an imdb.com title link it can be read from.
function parseImdbId(value) {
  const raw = cleanLine(value, 300);
  if (!raw) return { value: null };
  const m = raw.match(/^(tt\d{7,10})$/) || raw.match(/imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d{7,10})(?:[/?#]|$)/i);
  return m ? { value: m[1].toLowerCase() } : { error: "imdb_invalid" };
}

// Where a stream recording may point. A link on a card is shown to every visitor, so it is held
// to a short list of video hosts rather than "any URL": the card must not become a place to post
// arbitrary links under the channel's name.
const RECORDING_HOSTS = [
  { hosts: ["twitch.tv", "www.twitch.tv", "m.twitch.tv"], path: /^\/videos\/\d+\/?$/ },
  { hosts: ["youtube.com", "www.youtube.com", "m.youtube.com"], path: /^\/(watch|playlist|live\/[\w-]+)\/?$/ },
  { hosts: ["youtu.be"], path: /^\/[\w-]{6,20}\/?$/ },
  { hosts: ["vkvideo.ru", "www.vkvideo.ru", "vk.com", "www.vk.com", "vk.ru"], path: /^\/(video-?\d+_\d+|video\/@?[\w.-]+)/ },
  { hosts: ["rutube.ru", "www.rutube.ru"], path: /^\/video\/[0-9a-f]{20,40}\/?$/ },
];

function parseRecordingUrl(value) {
  const raw = cleanLine(value, 500);
  if (!raw) return { value: null };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "recording_invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "recording_invalid" };
  if (url.username || url.password || url.port) return { error: "recording_invalid" };
  const host = url.hostname.toLowerCase();
  const rule = RECORDING_HOSTS.find((r) => r.hosts.includes(host));
  if (!rule || !rule.path.test(url.pathname)) return { error: "recording_invalid" };
  if (rule.hosts.includes("youtube.com") && url.pathname === "/watch" && !url.searchParams.get("v")) {
    return { error: "recording_invalid" };
  }
  // A series streamed over several evenings is one playlist rather than one video.
  if (rule.hosts.includes("youtube.com") && /^\/playlist\/?$/.test(url.pathname)
      && !/^[\w-]{10,64}$/.test(url.searchParams.get("list") || "")) {
    return { error: "recording_invalid" };
  }
  url.protocol = "https:";
  url.hash = "";
  return { value: url.toString() };
}

// "How much was watched". A film is a percentage; a series or an anime counts episodes, with the
// total optional (unknown while it is still airing). Empty input = no progress shown at all.
function parseProgress({ done, total }, mediaType) {
  const blank = (v) => v === undefined || v === null || v === "";
  if (blank(done) && blank(total)) return { value: null };
  const d = Number(done);
  if (mediaType === "film") {
    if (!Number.isInteger(d) || d < 0 || d > 100) return { error: "progress_invalid" };
    return { value: { done: d, total: 100, unit: "percent" } };
  }
  const t = blank(total) ? null : Number(total);
  if (!Number.isInteger(d) || d < 0 || d > LIMITS.episodes) return { error: "progress_invalid" };
  if (t !== null && (!Number.isInteger(t) || t < 1 || t > LIMITS.episodes || d > t)) return { error: "progress_invalid" };
  return { value: { done: d, total: t, unit: "episode" } };
}

// The badge on a card: only while something is left to watch.
function progressBadge(progress) {
  if (!progress) return null;
  if (progress.unit === "percent") return progress.done < 100 ? { kind: "percent", done: progress.done } : null;
  if (progress.total !== null && progress.done >= progress.total) return null;
  return { kind: "episode", done: progress.done, total: progress.total };
}

// Plain-text start of the review for the grid - computed when the review is saved, so the grid
// never renders markdown per request.
function excerptFromHtml(html, max = LIMITS.excerpt) {
  const text = String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

// A Steam app id: the number itself, or a store link it can be read from
// (store.steampowered.com/app/292030/...). Only ever stored as a number - the poster URL the server
// downloads is built from it, so nothing else from the field reaches a request.
function parseSteamAppId(value) {
  const raw = cleanLine(value, 300);
  if (!raw) return { value: null };
  const m = raw.match(/^(\d{1,9})$/) || raw.match(/^(?:https?:\/\/)?store\.steampowered\.com\/app\/(\d{1,9})(?:[/?#]|$)/i);
  if (!m) return { error: "steam_invalid" };
  const n = Number(m[1]);
  return n > 0 ? { value: n } : { error: "steam_invalid" };
}

// The Twitch category the game was streamed under - the key to its hours on stream. Compared the
// way the bot compares categories (trim + lower case, lib/categoryLookup.js's categoryKey), so it
// is stored trimmed and nothing more.
function parseTwitchCategory(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { value: null };
  if (raw.length > MAX_CATEGORY_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) return { error: "category_invalid" };
  return { value: raw };
}

// The whole create/edit form. `canWriteStreamerFields`: the review and the streamer's own score
// are the owner's (an admin may write them on the owner's behalf); a moderator's form never
// carries them, and a forged POST from one is ignored here rather than trusted.
// `allowedStatuses` defaults to the editor's two; editing a suggestion adds its own status to the
// list so a fix to its title does not force a decision in the same save.
//
// `kind` "game" swaps the film fields for the game's: no type, no progress and no IMDb id; a Steam
// app id and the Twitch category name instead.
function parseMediaForm(body, { canWriteStreamerFields = false, now = new Date(), allowedStatuses = EDITOR_STATUSES, kind = "movie" } = {}) {
  const errors = [];
  const take = (result) => {
    if (result.error) errors.push(result.error);
    return result.value ?? null;
  };

  const title = cleanLine(body.title, LIMITS.title);
  if (!title) errors.push("title_required");
  const originalTitle = cleanLine(body.originalTitle, LIMITS.originalTitle) || null;
  const isGame = kind === "game";
  const mediaType = isGame ? null : MEDIA_TYPES.includes(body.mediaType) ? body.mediaType : null;
  if (!isGame && !mediaType) errors.push("type_invalid");
  const status = allowedStatuses.includes(body.status) ? body.status : null;
  if (!status) errors.push("status_invalid");

  const value = {
    title,
    originalTitle,
    searchKey: buildSearchKey(title, originalTitle),
    year: take(parseYear(body.year, now)),
    mediaType,
    status,
    imdbId: isGame ? null : take(parseImdbId(body.imdbId)),
    nsfw: body.nsfw === "1" || body.nsfw === "on" || body.nsfw === true,
    recordingUrl: take(parseRecordingUrl(body.recordingUrl)),
    progress: mediaType ? take(parseProgress({ done: body.progressDone, total: body.progressTotal }, mediaType)) : null,
  };
  if (isGame) {
    value.steamAppId = take(parseSteamAppId(body.steamAppId));
    value.twitchCategoryName = take(parseTwitchCategory(body.twitchCategoryName));
  }

  if (canWriteStreamerFields) {
    value.streamerRating = take(parseRating(body.streamerRating));
    const reviewRaw = typeof body.review === "string" ? body.review.trim().slice(0, LIMITS.review) : "";
    if (reviewRaw) {
      const bodyHtml = renderBody("markdown", reviewRaw);
      value.review = { bodyRaw: reviewRaw, bodyHtml, excerpt: excerptFromHtml(bodyHtml) };
    } else {
      value.review = null;
    }
  }

  return { errors: [...new Set(errors)], value };
}

// --- viewer ratings -----------------------------------------------------------------------

// How one viewer's (re-)rating moves the card's {sum, count}. Only a COUNTED rating (the viewer
// has chatted in this channel) is in the average; `previous` is the stored rating or null.
function viewerRatingDelta(previous, nextValue, nextCounted) {
  const before = previous && previous.counted ? previous.value : null;
  const after = nextCounted ? nextValue : null;
  return {
    sum: (after ?? 0) - (before ?? 0),
    count: (after === null ? 0 : 1) - (before === null ? 0 : 1),
  };
}

// Shown from the first counted rating on; one decimal, as IMDb shows it.
function viewerAverage(viewers) {
  if (!viewers || !(viewers.count > 0)) return null;
  return Math.round((viewers.sum / viewers.count) * 10) / 10;
}

// --- grid sorting -------------------------------------------------------------------------

// Sort specs in lib/cursorPaging.js's format. Rating sorts run in memory over the channel's cards
// (pageSorted); a card without the value sorts as -1, after every rated one. `missing: true` marks
// the sorts where -1 means "no value" (orderedSort keeps those cards last in either direction).
const SORTS = {
  added: { name: "added", key: "createdAt", type: "date", direction: -1 },
  streamer: { name: "streamer", key: "sortStreamer", type: "number", direction: -1, missing: true },
  viewers: { name: "viewers", key: "sortViewers", type: "number", direction: -1, missing: true },
  // IMDb's own rating, refreshed nightly from the dataset (jobs/imdbRatingsSync.js).
  imdb: { name: "imdb", key: "sortImdb", type: "number", direction: -1, missing: true },
  // Games: Steam's share of positive reviews, and the hours the game was on stream (computed per
  // request from the bot's samples - routes/gamesStream.js's decorateRows).
  steam: { name: "steam", key: "sortSteam", type: "number", direction: -1, missing: true },
  hours: { name: "hours", key: "sortHours", type: "number", direction: -1, missing: true },
  // Suggestions: the counted promote/not-now score (can be negative - no sentinel needed).
  score: { name: "score", key: "sortScore", type: "number", direction: -1 },
  // The size of the card's discussion (MediaItems.commentCount, kept by db/mediaThreads.js).
  comments: { name: "comments", key: "sortComments", type: "number", direction: -1 },
};
const DEFAULT_SORT = "added";

function resolveSort(value) {
  return Object.prototype.hasOwnProperty.call(SORTS, value) ? value : DEFAULT_SORT;
}

// The two orders of a sort: "desc" is the spec as written (best / newest first), "asc" the same
// spec reversed. The reversed one has its own name, so a cursor minted in one order is refused by the
// other (lib/cursorPaging.js writes the name into the cursor) instead of paging from the wrong place.
const SORT_DIRS = ["desc", "asc"];
function orderedSort(name, dir) {
  const base = SORTS[name] || SORTS[DEFAULT_SORT];
  return dir === "asc" ? { ...base, name: `${base.name}-asc`, direction: -base.direction, ascending: true } : base;
}

// A card without the sort's value stays at the end whichever way the list runs: ascending, the -1
// sentinel would otherwise put every unrated card first. A large finite number (not Infinity, which
// a JSON cursor cannot carry) sorts after every real value.
const MISSING_LAST = 1e9;
function placeMissing(spec) {
  if (!spec.ascending || !spec.missing) return (row) => row;
  return (row) => (row[spec.key] === -1 ? { ...row, [spec.key]: MISSING_LAST } : row);
}

function withSortKeys(item) {
  return {
    ...item,
    sortStreamer: item.ratings?.streamer ?? -1,
    sortViewers: viewerAverage(item.ratings?.viewers) ?? -1,
    // A film's outside rating, whichever source gave it (IMDb, or Shikimori for an anime IMDb lacks).
    sortImdb: ["imdb", "shikimori"].includes(item.ratings?.external?.source) ? item.ratings.external.value : -1,
    sortScore: item.votes?.score || 0,
    sortComments: item.commentCount || 0,
    sortSteam: item.ratings?.external?.source === "steam" ? item.ratings.external.value : -1,
    sortHours: Number.isFinite(item.streamMinutes) ? item.streamMinutes : -1,
  };
}

module.exports = {
  MEDIA_TYPES,
  EDITOR_STATUSES,
  LIMITS,
  RATING_MIN,
  RATING_MAX,
  RECORDING_HOSTS,
  SORTS,
  SORT_DIRS,
  orderedSort,
  placeMissing,
  DEFAULT_SORT,
  normalizeSearchText,
  buildSearchKey,
  matchesSearch,
  parseYear,
  parseRating,
  parseImdbId,
  parseRecordingUrl,
  parseSteamAppId,
  parseTwitchCategory,
  parseProgress,
  progressBadge,
  excerptFromHtml,
  parseMediaForm,
  viewerRatingDelta,
  viewerAverage,
  resolveSort,
  withSortKeys,
};
