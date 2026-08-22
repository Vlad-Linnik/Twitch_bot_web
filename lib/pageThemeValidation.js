// Pure helpers behind the per-user page theme (the "throne" skin on /<channel>/user/<name>,
// edited at /admin/page-themes/:userId). Same "extract it so npm test can reach it" convention
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
const { SUPPORTED_LOCALES } = require("../config/i18n");

const MAX_TITLE_LENGTH = 48;
const MAX_MOTTO_LENGTH = 120;
const MAX_PANEL_LABEL_LENGTH = 40;

// A user's uploads (backdrop + medallion, re-encoded to webp) may not exceed this in total.
// Site admins are exempt - see withinStorageQuota. The editor is admin-only for now, which
// makes the quota dormant by construction; it is written now so that opening the editor to
// channel owners later is a permission change rather than a new feature.
const MAX_USER_STORAGE_BYTES = 5 * 1024 * 1024;

// Named skins. Only one exists today; the field is stored so a second one ("silver", ...)
// doesn't require a migration of every existing document.
const THEMES = ["throne"];

// Palette presets. Each preset fixes the WHOLE palette (background, ink, gold ramp); a custom
// colour may only override the accent - the one token that can't make the page unreadable.
const ACCENT_PRESETS = ["brass", "crimson", "pale"];

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

// The four tiles in the hero. Six are offered, exactly four are shown - one row on a desktop,
// 2x2 on a phone. Their labels reuse the page's existing i18n keys (userDashboard.rank and
// friends); only firstSeen needed a new one, because no such line existed on the page before.
const TROPHIES = ["rank", "messages", "mentions", "firstSeen", "nicknames", "topEmote"];
const TROPHY_COUNT = 4;
const DEFAULT_TROPHIES = ["rank", "messages", "mentions", "firstSeen"];

// The five stat sections, keyed exactly as views/userDashboard.ejs's data-component values -
// the same keys routes/userDashboard.js's PANEL_FIELDS uses for the privacy toggles, so a
// renamed panel and a hidden panel can never disagree about which section they mean.
const PANELS = ["activity", "clouds", "mentions", "heatmap", "modLogs"];

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

// Panel headings are the one part of the theme that IS translated: they replace a UI string
// that already has a translation, so a single value would leave one locale reading Russian on
// an English page. Title and motto stay single-language on purpose - they name a person, the
// way a nickname does, and DB-sourced values are otherwise never translated in this project.
//
// An empty box means "keep the stock heading", so empty strings are dropped rather than
// stored: a stored "" would have to be told apart from an absent key at every read site.
function sanitizePanelLabels(body) {
  const labels = {};
  for (const panel of PANELS) {
    const perLocale = {};
    for (const locale of SUPPORTED_LOCALES) {
      const text = sanitizeText(body["panelLabels." + panel + "." + locale], MAX_PANEL_LABEL_LENGTH);
      if (text) perLocale[locale] = text;
    }
    if (Object.keys(perLocale).length > 0) labels[panel] = perLocale;
  }
  return labels;
}

// The heading to render for one panel: the theme's override for THIS locale, else the stock
// translation the caller passes in. A theme that only filled in Russian keeps English stock.
function resolvePanelLabel(theme, panel, locale, fallback) {
  return theme?.panelLabels?.[panel]?.[locale] || fallback;
}

// Defaults for a user with no document at all - the same "a missing doc still yields
// meaningful values" contract as lib/privacy.js's resolvePrivacy, so every read site can treat
// the theme as always present and only branch on `enabled`.
function resolveTheme(doc) {
  return {
    enabled: doc?.enabled === true,
    theme: pickFromList(doc?.theme, THEMES, THEMES[0]),
    title: doc?.title || "",
    motto: doc?.motto || "",
    accent: {
      preset: pickFromList(doc?.accent?.preset, ACCENT_PRESETS, ACCENT_PRESETS[0]),
      custom: normalizeHexColor(doc?.accent?.custom),
    },
    backdrop: {
      mode: pickFromList(doc?.backdrop?.mode, BACKDROP_MODES, BACKDROP_MODES[0]),
      preset: pickFromList(doc?.backdrop?.preset, BACKDROP_PRESETS, BACKDROP_PRESETS[0]),
      scope: pickFromList(doc?.backdrop?.scope, BACKDROP_SCOPES, BACKDROP_SCOPES[0]),
      uploadUrl: doc?.backdrop?.uploadUrl || null,
    },
    medallionUrl: doc?.medallionUrl || null,
    intro: doc?.intro !== false,
    trophies: sanitizeTrophies(doc?.trophies),
    panelLabels: doc?.panelLabels || {},
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
  return {
    enabled: body.enabled === "1" || body.enabled === "on",
    theme: pickFromList(body.theme, THEMES, current.theme),
    title: sanitizeText(body.title, MAX_TITLE_LENGTH),
    motto: sanitizeText(body.motto, MAX_MOTTO_LENGTH),
    accent: {
      preset: pickFromList(body["accent.preset"], ACCENT_PRESETS, ACCENT_PRESETS[0]),
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
    intro: body.intro === "1" || body.intro === "on",
    trophies: sanitizeTrophies(body.trophies),
    panelLabels: sanitizePanelLabels(body),
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
  MAX_PANEL_LABEL_LENGTH,
  MAX_USER_STORAGE_BYTES,
  THEMES,
  ACCENT_PRESETS,
  BACKDROP_MODES,
  BACKDROP_PRESETS,
  BACKDROP_SCOPES,
  TROPHIES,
  TROPHY_COUNT,
  DEFAULT_TROPHIES,
  PANELS,
  normalizeHexColor,
  sanitizeTrophies,
  resolvePanelLabel,
  resolveTheme,
  parseSubmittedTheme,
  withinStorageQuota,
};
