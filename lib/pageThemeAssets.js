// Image handling for the per-user page theme (the backdrop wallpaper and the medallion portrait
// on /<channel>/user/<name>). Same pipeline and the same reasoning as lib/newsImage.js: re-encode
// to webp and cap the dimension, because sharp's decode is also the validation - it throws on
// anything that isn't real image data, which the route turns into a 400.
//
// The two kinds are capped differently because they are drawn at wildly different sizes: the
// backdrop covers the viewport, the medallion is a portrait inside a laurel cartouche a few
// hundred pixels across, and shipping a 1920px file for it would cost bandwidth no one sees.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "themes");
const URL_PREFIX = "/uploads/themes/";
const WEBP_QUALITY = 82;

const KIND_MAX_WIDTH = {
  backdrop: 1920,
  medallion: 512,
};

// Returns the stored URL and the on-disk byte count - the caller needs the bytes to keep the
// per-user quota (lib/pageThemeValidation.js's withinStorageQuota) in step with reality rather
// than with the size of what was uploaded, which is always larger than the re-encoded file.
async function saveThemeImage(buffer, kind) {
  const maxWidth = KIND_MAX_WIDTH[kind];
  if (!maxWidth) throw new Error(`unknown theme image kind: ${kind}`);

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const outputBuffer = await sharp(buffer)
    .rotate() // auto-orients from EXIF, then strips it - the re-encode drops all other metadata too
    .resize({ width: maxWidth, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const { width, height } = await sharp(outputBuffer).metadata();

  const filename = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), outputBuffer);

  return { url: URL_PREFIX + filename, bytes: outputBuffer.length, width, height };
}

// path.basename() drops any directory component a malformed stored URL might carry, so neither
// helper below can reach outside UPLOAD_DIR.
function resolveStoredPath(url) {
  if (!url || !url.startsWith(URL_PREFIX)) return null;
  return path.join(UPLOAD_DIR, path.basename(url));
}

// How much quota the file behind this URL is currently occupying. A missing file counts as 0
// rather than throwing: the quota must not be the thing that breaks a save because someone
// cleaned up public/uploads/ by hand.
async function themeImageBytes(url) {
  const filePath = resolveStoredPath(url);
  if (!filePath) return 0;
  try {
    return (await fs.stat(filePath)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

// Best-effort, called from the replace/remove paths. The document must be updated too - an
// unlinked file whose URL is still stored renders as a broken image.
async function deleteThemeImage(url) {
  const filePath = resolveStoredPath(url);
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[pageThemeAssets] failed to delete", filePath, err.message);
  }
}

module.exports = { saveThemeImage, themeImageBytes, deleteThemeImage, KIND_MAX_WIDTH };
