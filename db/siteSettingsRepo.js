// Site-wide switches that belong to nobody's channel - currently only the seasonal theme
// override. Web db (connectWeb): the bot has no business reading how the site is decorated.
//
// One document per setting, keyed by a fixed _id. The override is read on EVERY page render
// (middleware/seasonalTheme.js), so it is held in memory for a few seconds; a save here updates
// that copy at once, so the admin who changed it sees the result on the very next page. Another
// process (there is one) catches up within the TTL.
const { connectWeb } = require("./connection");
const { DEFAULT_OVERRIDE, OVERRIDE_MODES } = require("../lib/seasonalThemes");

const SEASONAL_THEME_ID = "seasonalTheme";
const CACHE_TTL_MS = 10 * 1000;

let collection;
let cached = null; // { value, expiresAt }
let inflight = null;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("SiteSettings");
  return collection;
}

function toOverride(doc) {
  if (!doc || !OVERRIDE_MODES.includes(doc.mode)) return { ...DEFAULT_OVERRIDE };
  return {
    mode: doc.mode,
    themeId: doc.mode === "force" && typeof doc.themeId === "string" ? doc.themeId : null,
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || null,
  };
}

// Never throws: a decoration must not be able to fail a page render. A read error degrades to
// "auto" and is not cached, so the next request tries again.
async function getSeasonalOverride() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const col = await ensureInitialized();
      const value = toOverride(await col.findOne({ _id: SEASONAL_THEME_ID }));
      cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
      return value;
    } catch (err) {
      console.error("[siteSettings] Failed to read seasonal theme override:", err.message);
      return { ...DEFAULT_OVERRIDE };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// `override` must already be validated (lib/seasonalThemes.js parseOverride).
async function saveSeasonalOverride(override, admin) {
  const col = await ensureInitialized();
  const doc = {
    mode: override.mode,
    themeId: override.mode === "force" ? override.themeId : null,
    updatedAt: new Date(),
    updatedBy: admin ? { userId: String(admin.userId), login: admin.login || admin.displayName || null } : null,
  };
  await col.updateOne({ _id: SEASONAL_THEME_ID }, { $set: doc }, { upsert: true });
  const value = toOverride(doc);
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

module.exports = { getSeasonalOverride, saveSeasonalOverride };
