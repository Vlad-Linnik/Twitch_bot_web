// Pure half of the "does this Twitch category exist?" check behind the custom-command form's
// per-category text rows (views/customCommands.ejs, public/js/custom-commands.js). The Helix calls
// and the cache live in twitch/categoryLookup.js; everything that decides what counts as a match
// lives here, so it is testable without the network.
//
// The match rule is the BOT's, not a friendlier one. TwitchBot/commands/CustomCommands.js's
// resolveCommandText picks an override with
//   ct.category.toLowerCase() === category.toLowerCase()
// where `category` is the stream's Helix game_name and `ct.category` is what this panel stored -
// which lib/commandValidation.js's parseCategoryTexts trims and nothing else. So a green check here
// must mean exactly "trim + lowercase equals some real game_name": no whitespace collapsing, no
// homoglyph folding, no accent stripping. A looser check would draw a green border around a value
// the bot then never matches in a live stream - the one outcome this indicator exists to prevent.

const { MAX_CATEGORY_LENGTH } = require("./commandValidation");
const { isAllowedImageUrl } = require("./emoteImageHosts");

const MAX_SUGGESTIONS = 3;

// Twitch box art is 3:4 portrait. The form shows it ~28px tall inside the input; 2x for crispness.
const BOX_ART_WIDTH = 42;
const BOX_ART_HEIGHT = 56;

// The comparison key: the exact transformation the bot applies to both sides.
function categoryKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

// Validates the ?name= query of the lookup endpoint. Returns the trimmed name to send to Helix -
// the same value parseCategoryTexts would store.
function parseCategoryQuery(raw) {
  if (typeof raw !== "string") return { ok: false, error: "category_required" };
  const name = raw.trim();
  if (!name) return { ok: false, error: "category_required" };
  if (name.length > MAX_CATEGORY_LENGTH) return { ok: false, error: "category_too_long" };
  return { ok: true, name };
}

// Helix returns box art in two shapes: Get Games gives a template with "{width}x{height}",
// Search Categories an already-sized file ending in "-52x72.jpg". Both are normalised to one size.
// Anything not on an origin our CSP allows comes back null - the browser would refuse it anyway,
// and a broken image next to "found" reads worse than no image.
function sizeBoxArtUrl(url, width = BOX_ART_WIDTH, height = BOX_ART_HEIGHT) {
  if (typeof url !== "string" || !url) return null;
  let sized = url;
  if (sized.includes("{width}") || sized.includes("{height}")) {
    sized = sized.replace("{width}", String(width)).replace("{height}", String(height));
  } else {
    sized = sized.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, `-${width}x${height}$1`);
  }
  return isAllowedImageUrl(sized) ? sized : null;
}

// The game whose name the bot would treat as equal to `query`, or null.
function pickExactGame(games, query) {
  const key = categoryKey(query);
  if (!key || !Array.isArray(games)) return null;
  return games.find((g) => g && typeof g.name === "string" && categoryKey(g.name) === key) || null;
}

// Near misses from Search Categories, offered as "did you mean". Excludes the query itself and
// repeats; Twitch's own relevance order is kept.
function suggestionsFrom(games, query, max = MAX_SUGGESTIONS) {
  const key = categoryKey(query);
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(games) ? games : []) {
    if (!g || typeof g.name !== "string" || !g.name.trim()) continue;
    const k = categoryKey(g.name);
    if (k === key || seen.has(k)) continue;
    seen.add(k);
    out.push(g.name);
    if (out.length >= max) break;
  }
  return out;
}

// The endpoint's JSON for a resolved lookup. `exact` is what Get Games and/or Search Categories
// matched (or null), `searchResults` the raw search list used for suggestions.
function buildLookupResult(query, exact, searchResults) {
  if (exact) {
    return {
      status: "found",
      name: exact.name,
      boxArtUrl: sizeBoxArtUrl(exact.box_art_url),
    };
  }
  return { status: "notFound", suggestions: suggestionsFrom(searchResults, query) };
}

module.exports = {
  MAX_SUGGESTIONS,
  categoryKey,
  parseCategoryQuery,
  sizeBoxArtUrl,
  pickExactGame,
  suggestionsFrom,
  buildLookupResult,
};
