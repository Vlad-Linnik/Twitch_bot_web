// Donation media panel: what each button's icon is. Pure - the setup page validates with it, the
// manager resolves with it, the tests read it.
//
// A theme maps SLOTS (a button or toggle of the queue panel) to icons. Three themes:
//   default  the panel's own emoji, as it always looked
//   7tv      7TV emotes, one per slot (SEVEN_TV), the ids taken from the channels' own 7TV sets
//            where the emote is in one, else the most popular upload of that exact name
//   custom   the channel's own choice per slot: 7TV emotes and/or uploaded pictures; an empty slot
//            falls back to the default emoji
// On top of the theme, an Easter egg (DonationMediaEasterEggs, edited by the site admin) can swap a
// slot's icon while one particular video plays - e.g. "skip" becomes two emotes on one track.
//
// An icon is { kind: "7tv", id } or { kind: "upload", url }; a slot holds 1..MAX_ICONS_PER_SLOT of
// them, drawn side by side. What reaches the panel is resolved to picture URLs ({ imgs: [url] }) or
// left as the default emoji ({ emoji }).

const SLOTS = [
  { key: "resume", emoji: "▶" },
  { key: "pause", emoji: "⏸" },
  { key: "skip", emoji: "⏭" },
  { key: "restart", emoji: "↺" },
  { key: "radio", emoji: "📻" },
  { key: "moreArtist", emoji: "👤" },
  { key: "hide", emoji: "🙈" },
  { key: "blur", emoji: "🌫" },
  { key: "image", emoji: "🖼" },
  { key: "autoPlaylist", emoji: "🎶" },
  { key: "infinite", emoji: "♾" },
];
const SLOT_KEYS = SLOTS.map((s) => s.key);
const THEMES = ["default", "7tv", "custom"];
const MAX_ICONS_PER_SLOT = 4;

const sevenTv = (id) => ({ kind: "7tv", id });
// name -> id, for the editor's labels and for the tests.
const SEVEN_TV_IDS = {
  pepeJAM: "01EZY967K0000CYST6006V20T8",
  peepoStop: "01F7KRAZF0000ERW8ZAA08S06M",
  peepoRIP: "01H0TFD12R0005HNCSM10SYQ6D",
  catJAMMER: "01FCJEJWF00003YFMSVPT64Z55",
  peepoDJ: "01FBS4X63R000AAZQB4F0E7SEB",
  StillBlago: "01JMF053F1D8N74CZAGMMS7RRV",
  monkaT: "01F7GWFC2R000AHYA9JNNBZTVA",
  monkaSpeed: "01F6SHVZNG0007A0569XY46T4D",
  Jokerge: "01GB8R1ZF0000BX30STW7STTS2",
  Boglet: "01JMZQR1KTQQ9NDKX7FA20NRJ8",
  KeepGambling: "01FZXV2TWR000E0BZ1K0G6CTBS",
  Tssk: "01F6M8S930000B5V5G2M2GBRHN",
};
const SEVEN_TV = {
  resume: [sevenTv(SEVEN_TV_IDS.pepeJAM)],
  pause: [sevenTv(SEVEN_TV_IDS.peepoStop)],
  skip: [sevenTv(SEVEN_TV_IDS.peepoRIP)],
  restart: [sevenTv(SEVEN_TV_IDS.catJAMMER)],
  radio: [sevenTv(SEVEN_TV_IDS.peepoDJ)],
  moreArtist: [sevenTv(SEVEN_TV_IDS.StillBlago)],
  hide: [sevenTv(SEVEN_TV_IDS.monkaT)],
  blur: [sevenTv(SEVEN_TV_IDS.monkaSpeed)],
  image: [sevenTv(SEVEN_TV_IDS.Jokerge)],
  autoPlaylist: [sevenTv(SEVEN_TV_IDS.Boglet)],
  infinite: [sevenTv(SEVEN_TV_IDS.KeepGambling)],
};

const SEVEN_TV_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-f]{24}$/; // ULID (current) or ObjectId (old links)
const UPLOAD_URL_RE = /^\/uploads\/donation-media\/icons\/[a-f0-9]{32}\.webp$/;

function sevenTvUrl(id) {
  return `https://cdn.7tv.app/emote/${id}/2x.webp`;
}

function validIcon(icon) {
  if (!icon || typeof icon !== "object") return null;
  if (icon.kind === "7tv" && typeof icon.id === "string" && SEVEN_TV_ID_RE.test(icon.id)) return { kind: "7tv", id: icon.id };
  if (icon.kind === "upload" && typeof icon.url === "string" && UPLOAD_URL_RE.test(icon.url)) return { kind: "upload", url: icon.url };
  return null;
}

function validIcons(list) {
  return (Array.isArray(list) ? list : []).map(validIcon).filter(Boolean).slice(0, MAX_ICONS_PER_SLOT);
}

// A 7TV emote as an owner pastes it: a link (7tv.app/emotes/<id>, a CDN URL) or the bare id.
// Returns the id, or null. A name needs a lookup (see resolveSevenTvName in the route).
function parseSevenTvRef(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const m = s.match(/(?:7tv\.app\/emotes\/|cdn\.7tv\.app\/emote\/)([0-9A-Za-z]{24,26})/);
  const id = m ? m[1] : s;
  return SEVEN_TV_ID_RE.test(id) ? id : null;
}

// The stored panel settings, cleaned: { theme, custom: { slot: [icon] }, historyLimit }.
const HISTORY_MIN = 5;
const HISTORY_MAX = 50;
function normalizeButtons(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const custom = {};
  for (const key of SLOT_KEYS) {
    const icons = validIcons(s.custom && s.custom[key]);
    if (icons.length) custom[key] = icons;
  }
  return { theme: THEMES.includes(s.theme) ? s.theme : "default", custom };
}

function clampHistoryLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return HISTORY_MAX;
  return Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, n));
}

function iconUrl(icon) {
  return icon.kind === "7tv" ? sevenTvUrl(icon.id) : icon.url;
}

// What the panel draws for every slot: { slot: { imgs: [url] } | { emoji } }. `egg`: the Easter
// egg of the video playing now, { slot: [icon] } - it wins over the theme for its slots.
function resolveIcons(buttons, egg = null) {
  const b = normalizeButtons(buttons);
  const out = {};
  for (const { key, emoji } of SLOTS) {
    let icons = null;
    if (egg && egg[key] && egg[key].length) icons = egg[key];
    else if (b.theme === "7tv") icons = SEVEN_TV[key];
    else if (b.theme === "custom" && b.custom[key]) icons = b.custom[key];
    out[key] = icons ? { imgs: icons.map(iconUrl) } : { emoji };
  }
  return out;
}

// --- Easter eggs ----------------------------------------------------------------------------------

// One egg: { videoId, icons: { slot: [icon] }, note }. Returns the cleaned egg or null.
function normalizeEgg(egg) {
  if (!egg || typeof egg.videoId !== "string" || !/^[\w-]{11}$/.test(egg.videoId)) return null;
  const icons = {};
  for (const key of SLOT_KEYS) {
    const list = validIcons(egg.icons && egg.icons[key]);
    if (list.length) icons[key] = list;
  }
  if (Object.keys(icons).length === 0) return null;
  return { videoId: egg.videoId, icons, note: String(egg.note || "").slice(0, 200) };
}

module.exports = {
  SLOTS,
  SLOT_KEYS,
  THEMES,
  SEVEN_TV,
  SEVEN_TV_IDS,
  MAX_ICONS_PER_SLOT,
  HISTORY_MIN,
  HISTORY_MAX,
  sevenTvUrl,
  validIcon,
  validIcons,
  parseSevenTvRef,
  normalizeButtons,
  clampHistoryLimit,
  resolveIcons,
  normalizeEgg,
};
