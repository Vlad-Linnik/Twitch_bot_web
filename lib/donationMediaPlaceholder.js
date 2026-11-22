// The channel's own placeholder picture for donation media - what the OBS player shows over a clip
// a moderator covered with "placeholder" (lib/donationMediaQueue.js's cover "image"). Uploaded by
// the channel owner on the setup page; without one the player draws its built-in card.
//
// The upload is never stored as sent: it is decoded and a new WebP is encoded from the pixels, as
// with every uploaded picture on the site (lib/userImageGuard.js has the reasoning). Unlike a
// poster, a GIF is welcome here - an animated placeholder is the usual choice on stream - so an
// animated input stays animated, bounded by frame count and total pixels instead of refused.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "donation-media");
const URL_PREFIX = "/uploads/donation-media/";
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 4000;
const MAX_FRAMES = 300;
// Every frame decoded, summed: the ceiling that stops a small GIF from unpacking into gigabytes.
const MAX_TOTAL_PIXELS = 150_000_000;
// The player is an OBS source, rarely larger than 1080p; a placeholder is scaled to fit inside.
const OUT_WIDTH = 1280;
const OUT_HEIGHT = 720;

class PlaceholderError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The format by its first bytes; the name and type the browser sent are never read.
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  return null;
}

// buffer -> WebP buffer, scaled to fit inside `width` x `height` (the panel's button icons use
// the same encoder at icon size). Throws PlaceholderError: not_allowed_type | unreadable | too_large.
async function encodePlaceholder(buf, { width: outWidth = OUT_WIDTH, height: outHeight = OUT_HEIGHT } = {}) {
  const sniffed = sniff(buf);
  if (!sniffed) throw new PlaceholderError("not_allowed_type");
  let meta;
  try {
    meta = await sharp(buf, { animated: true, limitInputPixels: false }).metadata();
  } catch (_) {
    throw new PlaceholderError("unreadable");
  }
  if (meta.format !== sniffed) throw new PlaceholderError("unreadable");
  const pages = meta.pages || 1;
  const frameHeight = meta.pageHeight || meta.height;
  const { width } = meta;
  if (!Number.isInteger(width) || !Number.isInteger(frameHeight) || width < 1 || frameHeight < 1) {
    throw new PlaceholderError("unreadable");
  }
  if (width > MAX_SIDE || frameHeight > MAX_SIDE || pages > MAX_FRAMES || width * frameHeight * pages > MAX_TOTAL_PIXELS) {
    throw new PlaceholderError("too_large");
  }
  try {
    return await sharp(buf, { animated: pages > 1, limitInputPixels: MAX_TOTAL_PIXELS, failOn: "error" })
      .resize({ width: outWidth, height: outHeight, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (_) {
    throw new PlaceholderError("unreadable");
  }
}

async function savePlaceholder(buf) {
  const out = await encodePlaceholder(buf);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), out);
  return URL_PREFIX + name;
}

// Only a file of ours, by its exact name shape - the stored value is never trusted as a path.
async function deletePlaceholder(url) {
  const match = typeof url === "string" && url.match(/^\/uploads\/donation-media\/([0-9a-f-]{36}\.webp)$/);
  if (!match) return;
  await fs.unlink(path.join(UPLOAD_DIR, match[1])).catch(() => {});
}

function isPlaceholderUrl(url) {
  return typeof url === "string" && /^\/uploads\/donation-media\/[0-9a-f-]{36}\.webp$/.test(url);
}

module.exports = {
  MAX_UPLOAD_BYTES,
  PlaceholderError,
  sniff,
  encodePlaceholder,
  savePlaceholder,
  deletePlaceholder,
  isPlaceholderUrl,
};
