// The channel's own pictures for the queue panel's buttons (lib/donationMediaIcons.js, the
// "custom" theme) and for the admin's Easter eggs. Re-encoded like every uploaded picture on the
// site - lib/donationMediaPlaceholder.js's encoder, at icon size; animated stays animated.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { encodePlaceholder, PlaceholderError, MAX_UPLOAD_BYTES } = require("./donationMediaPlaceholder");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "donation-media", "icons");
const URL_PREFIX = "/uploads/donation-media/icons/";
// Drawn at about 1.4em in the panel; twice that for a sharp picture on a HiDPI screen.
const ICON_SIDE = 128;

// buffer -> "/uploads/donation-media/icons/<32 hex>.webp". Throws PlaceholderError.
async function saveIcon(buf) {
  const out = await encodePlaceholder(buf, { width: ICON_SIDE, height: ICON_SIDE });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString("hex")}.webp`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), out);
  return URL_PREFIX + name;
}

// Only a file of ours, by its exact name shape - the stored value is never trusted as a path.
async function deleteIcon(url) {
  const match = typeof url === "string" && url.match(/^\/uploads\/donation-media\/icons\/([a-f0-9]{32}\.webp)$/);
  if (!match) return;
  await fs.unlink(path.join(UPLOAD_DIR, match[1])).catch(() => {});
}

// Every uploaded icon URL in a { slot: [icon] } map.
function uploadsIn(iconMap) {
  const out = [];
  for (const list of Object.values(iconMap || {})) for (const icon of list || []) if (icon && icon.kind === "upload") out.push(icon.url);
  return out;
}

module.exports = { saveIcon, deleteIcon, uploadsIn, PlaceholderError, MAX_UPLOAD_BYTES };
