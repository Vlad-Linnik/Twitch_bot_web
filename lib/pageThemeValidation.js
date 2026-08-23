// Pure helpers behind the per-user page themes - the skins that replace the default look of
// /<channel>/user/<name>, edited at /admin/page-themes/:userId. Same "extract it so npm test can reach it" convention
// as lib/settingsValidation.js and lib/newsValidation.js - the route stays thin and every rule
// below is covered by tests/pageThemeValidation.test.js.
//
// Two things this module deliberately does NOT know about:
//   - the actual palette hex values. A preset is a NAME here; its colours live in
//     public/css/input.css as CSS custom properties, so the palette exists in exactly one
//     place and the server never has to agree with the stylesheet about what "brass" means.
//   - files. Uploads (size, re-encode, the per-user storage quota's enforcement) belong to
//     lib/pageThemeAssets.js; this module only carries the already-stored URLs and byte count
//     through a save so a text-only edit can't wipe them.

const MAX_TITLE_LENGTH = 48;
const MAX_MOTTO_LENGTH = 120;

// A user's uploads (backdrop + medallion, re-encoded to webp) may not exceed this in total.
// Site admins are exempt - see withinStorageQuota. The editor is admin-only for now, which
// makes the quota dormant by construction; it is written now so that opening the editor to
// channel owners later is a permission change rather than a new feature.
const MAX_USER_STORAGE_BYTES = 5 * 1024 * 1024;

// Named skins. Both draw the SAME room (views/partials/throne*.ejs) - a skin swaps the
// materials it is built from, not its geometry, which is why there is one set of partials and
// one set of CSS custom properties rather than a second copy of each per theme.
const THEMES = ["throne", "rose"];

// Palette presets, per skin. Each preset fixes the WHOLE palette (background, ink, metal ramp),
// so the sets are not interchangeable: "brass" means nothing in a rose room. A custom colour may
// only override the accent - the one token that can't make the page unreadable.
//
// The first entry of a list is that skin's default, and the fallback when a preset belonging to
// the other skin is submitted - which is exactly what a no-JS theme swap in the editor sends.
const ACCENT_PRESETS = {
  throne: ["brass", "crimson", "pale"],
  rose: ["bubblegum", "dusty", "powder", "fuchsia"],
};

// An unknown theme resolves to the default skin's presets rather than to an empty list, so a
// document written by a future version can still produce a renderable palette instead of
// `undefined[0]`.
function presetsForTheme(theme) {
  return ACCENT_PRESETS[theme] || ACCENT_PRESETS[THEMES[0]];
}

// Vector = the hall drawn as SVG/CSS, photo = a wallpaper behind it. In photo mode the
// wallpaper is either one of the presets shipped in public/img/themes/ or the user's own
// upload; uploadUrl winning over preset is what makes "upload" feel like it took effect.
const BACKDROP_MODES = ["vector", "photo"];
const BACKDROP_PRESETS = ["hall", "ceiling", "colonnade"];

// How far the hall reaches. "hero" keeps it behind the throne, ending where the stats begin;
// "page" fixes the columns and the wallpaper to the viewport so the whole page scrolls inside
// the room. The cornice stays in the hero either way - it is the top of the wall, and fixing it
// to the viewport would put a second bar under the nav on every scroll position.
const BACKDROP_SCOPES = ["hero", "page"];

// The Steam display case. Only the profile URL is edited; the items behind it are DERIVED - the
// admin route syncs them through lib/steamShowcase.js and writes them back, the same way upload
// URLs are written by the upload handler rather than by the form. Carrying them through a save
// untouched is what stops a text-only edit from emptying the case.
const { parseProfileUrl } = require("./steamShowcase");
const MAX_SHOWCASE_ITEMS = 12;

// Items come out of scraped HTML, so nothing about them is trusted on the way back OUT of the
// database either: a stored item is re-checked before it can reach a style attribute or an <img>.
function sanitizeShowcaseItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.image === "string" && item.image.startsWith("/uploads/themes/"))
    .slice(0, MAX_SHOWCASE_ITEMS)
    .map((item) => ({
      image: item.image,
      name: typeof item.name === "string" ? item.name.slice(0, 120) : null,
      borderColor: normalizeHexColor(item.borderColor),
    }));
}

// The four tiles in the hero. Six are offered, exactly four are shown - one row on a desktop,
// 2x2 on a phone. Their labels reuse the page's existing i18n keys (userDashboard.rank and
// friends); only firstSeen needed a new one, because no such line existed on the page before.
const TROPHIES = ["rank", "messages", "mentions", "firstSeen", "nicknames", "topEmote"];
const TROPHY_COUNT = 4;
const DEFAULT_TROPHIES = ["rank", "messages", "mentions", "firstSeen"];

function sanitizeText(value, maxLength) {
  return (value ?? "").toString().trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function pickFromList(value, list, fallback) {
  const candidate = (value ?? "").toString();
  return list.includes(candidate) ? candidate : fallback;
}

// #abc and #aabbcc only. Returns lowercase #rrggbb, or null for anything else - null means
// "no custom colour", which is a valid state (the preset's own accent is used).
function normalizeHexColor(value) {
  const raw = (value ?? "").toString().trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(raw);
  if (short) {
    const [r, g, b] = short[1];
    return "#" + r + r + g + g + b + b;
  }
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

// Unknown keys dropped, duplicates collapsed, then padded from DEFAULT_TROPHIES so the hero
// always has exactly four tiles. Padding rather than rejecting: a half-filled row is a layout
// bug on a page nobody would think to re-check, while a silently completed row is correct.
function sanitizeTrophies(value) {
  const submitted = Array.isArray(value) ? value : [value];
  const chosen = [];
  for (const item of submitted) {
    const key = (item ?? "").toString();
    if (TROPHIES.includes(key) && !chosen.includes(key)) chosen.push(key);
    if (chosen.length === TROPHY_COUNT) break;
  }
  for (const key of DEFAULT_TROPHIES) {
    if (chosen.length === TROPHY_COUNT) break;
    if (!chosen.includes(key)) chosen.push(key);
  }
  return chosen;
}

// Defaults for a user with no document at all - the same "a missing doc still yields
// meaningful values" contract as lib/privacy.js's resolvePrivacy, so every read site can treat
// the theme as always present and only branch on `enabled`.
function resolveTheme(doc) {
  // The skin is resolved FIRST: it decides which list the stored preset is checked against.
  const theme = pickFromList(doc?.theme, THEMES, THEMES[0]);
  const presets = presetsForTheme(theme);
  return {
    enabled: doc?.enabled === true,
    theme,
    title: doc?.title || "",
    motto: doc?.motto || "",
    accent: {
      preset: pickFromList(doc?.accent?.preset, presets, presets[0]),
      custom: normalizeHexColor(doc?.accent?.custom),
    },
    backdrop: {
      mode: pickFromList(doc?.backdrop?.mode, BACKDROP_MODES, BACKDROP_MODES[0]),
      preset: pickFromList(doc?.backdrop?.preset, BACKDROP_PRESETS, BACKDROP_PRESETS[0]),
      scope: pickFromList(doc?.backdrop?.scope, BACKDROP_SCOPES, BACKDROP_SCOPES[0]),
      uploadUrl: doc?.backdrop?.uploadUrl || null,
    },
    medallionUrl: doc?.medallionUrl || null,
    steam: {
      profileUrl: parseProfileUrl(doc?.steam?.profileUrl),
      syncedAt: doc?.steam?.syncedAt || null,
      items: sanitizeShowcaseItems(doc?.steam?.items),
    },
    intro: doc?.intro !== false,
    trophies: sanitizeTrophies(doc?.trophies),
    storageBytes: Number.isFinite(doc?.storageBytes) ? doc.storageBytes : 0,
  };
}

// Form -> stored shape. This form renders every field it owns, so an absent checkbox really
// does mean "off" (unlike the settings form, which is split across pages and needs .present
// markers). What it does NOT render is the uploads: those are written by lib/pageThemeAssets.js
// on their own request, so they are carried over from `existing` and can't be cleared by a
// text-only save.
function parseSubmittedTheme(body, existing) {
  const current = resolveTheme(existing);
  // Same order as resolveTheme, and it matters more here: switching the skin and the palette in
  // one submit means the incoming preset has to be checked against the INCOMING skin's list, not
  // the stored one, or every theme swap would be rejected back to the old skin's default.
  const theme = pickFromList(body.theme, THEMES, current.theme);
  const presets = presetsForTheme(theme);
  return {
    enabled: body.enabled === "1" || body.enabled === "on",
    theme,
    title: sanitizeText(body.title, MAX_TITLE_LENGTH),
    motto: sanitizeText(body.motto, MAX_MOTTO_LENGTH),
    accent: {
      preset: pickFromList(body["accent.preset"], presets, presets[0]),
      // Only consulted when the form's colour mode is "custom"; an unparseable value falls
      // back to the preset's own accent rather than failing the save.
      custom: body["accent.mode"] === "custom" ? normalizeHexColor(body["accent.custom"]) : null,
    },
    backdrop: {
      mode: pickFromList(body["backdrop.mode"], BACKDROP_MODES, BACKDROP_MODES[0]),
      preset: pickFromList(body["backdrop.preset"], BACKDROP_PRESETS, BACKDROP_PRESETS[0]),
      scope: pickFromList(body["backdrop.scope"], BACKDROP_SCOPES, BACKDROP_SCOPES[0]),
      uploadUrl: current.backdrop.uploadUrl,
    },
    medallionUrl: current.medallionUrl,
    steam: {
      profileUrl: parseProfileUrl(body["steam.profileUrl"]),
      // Items and the sync stamp are the route's to write - see the note by MAX_SHOWCASE_ITEMS.
      // Clearing the URL clears the case, which is the only way to remove it from the form.
      syncedAt: current.steam.syncedAt,
      items: current.steam.items,
    },
    intro: body.intro === "1" || body.intro === "on",
    trophies: sanitizeTrophies(body.trophies),
    storageBytes: current.storageBytes,
  };
}

// Quota check for an incoming upload. `replacedBytes` is the size of the file this upload
// overwrites (0 when there is none) - without it, replacing a 3MB backdrop with another 3MB
// backdrop would count as 6MB and be refused, which is the opposite of what a replace means.
function withinStorageQuota({ storageBytes = 0, incomingBytes, replacedBytes = 0, isAdmin = false }) {
  if (isAdmin) return true;
  return storageBytes - replacedBytes + incomingBytes <= MAX_USER_STORAGE_BYTES;
}

module.exports = {
  MAX_TITLE_LENGTH,
  MAX_MOTTO_LENGTH,
  MAX_USER_STORAGE_BYTES,
  THEMES,
  ACCENT_PRESETS,
  presetsForTheme,
  BACKDROP_MODES,
  BACKDROP_PRESETS,
  BACKDROP_SCOPES,
  MAX_SHOWCASE_ITEMS,
  sanitizeShowcaseItems,
  TROPHIES,
  TROPHY_COUNT,
  DEFAULT_TROPHIES,
  normalizeHexColor,
  sanitizeTrophies,
  resolveTheme,
  parseSubmittedTheme,
  withinStorageQuota,
};
