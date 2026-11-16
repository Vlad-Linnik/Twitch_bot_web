// Posters for movie and game cards. Every poster is stored twice, always:
//   - the normal copy, webp, at most POSTER_WIDTH wide (the grid draws ~200 px, x2 for dense
//     screens);
//   - a blurred copy BLUR_WIDTH wide, blurred in the file itself and stretched by the browser.
// The blur is baked in because an 18+ cover must not show by accident - to a viewer at work, or
// to the streamer opening the page on stream - and a CSS blur is undone by disabling styles,
// "view source" or reader mode. For an 18+ card the grid, and anything else that is not the
// card's own page, only ever references the blurred file; the normal one is named by an
// unrelated random UUID, so it cannot be guessed from the blurred URL. Making both copies for
// every card means a moderator can tick or untick 18+ at any time without re-uploading.
//
// This is not access control: anyone who opens the card and presses "show" sees the cover, and
// that is intended.
//
// sharp is also the validation: anything that is not decodable image data throws, and the caller
// turns that into a form error.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "media");
const URL_PREFIX = "/uploads/media/";
const POSTER_WIDTH = 400;
const BLUR_WIDTH = 32;
const WEBP_QUALITY = 82;

// Decode and re-encode: only pixels survive, never a byte of the input file. `sharpOptions` lets
// the viewer-upload barrier (lib/userImageGuard.js) decode under its pixel ceiling and fail on any
// decode error; trusted inputs use sharp's defaults.
async function encodePoster(buffer, sharpOptions = {}) {
  const normal = await sharp(buffer, sharpOptions)
    .rotate() // EXIF orientation applied, then all metadata dropped by the re-encode
    .resize({ width: POSTER_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const { width, height } = await sharp(normal).metadata();
  const blurred = await sharp(normal).resize({ width: BLUR_WIDTH }).blur(1.5).webp({ quality: 60 }).toBuffer();
  return { normal, blurred, width, height };
}

// `approved: false` marks a viewer's own upload: until a moderator approves it (or accepts the
// suggestion), only its author and levels 0-2 see it - see isPosterVisible.
async function savePoster(buffer, { source = "upload", sharpOptions = {}, approved = true } = {}) {
  const { normal, blurred, width, height } = await encodePoster(buffer, sharpOptions);
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const normalName = `${crypto.randomUUID()}.webp`;
  const blurName = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(UPLOAD_DIR, normalName), normal);
  await fs.writeFile(path.join(UPLOAD_DIR, blurName), blurred);

  return { url: URL_PREFIX + normalName, blurUrl: URL_PREFIX + blurName, width, height, source, approved };
}

// Best-effort, for delete and replace. path.basename() drops any directory part a malformed stored
// URL might carry, so this can never reach outside UPLOAD_DIR.
async function deletePoster(poster) {
  if (!poster) return;
  for (const url of [poster.url, poster.blurUrl]) {
    if (typeof url !== "string" || !url.startsWith(URL_PREFIX)) continue;
    const filePath = path.join(UPLOAD_DIR, path.basename(url));
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== "ENOENT") console.error("[mediaImage] failed to delete", filePath, err.message);
    }
  }
}

// Whether this viewer may see the card's cover at all. A viewer's own upload stays hidden from
// everyone but its author and levels 0-2 until it is approved - the barrier against unpleasant
// content that no file check can provide. Posters with no `approved` field (editors' uploads,
// source downloads, everything stored before this existed) are approved.
function isPosterVisible(item, viewer = {}) {
  if (!item.poster) return false;
  if (item.poster.approved !== false) return true;
  if (Number.isInteger(viewer.permission) && viewer.permission <= 2) return true;
  return Boolean(viewer.userId) && String(viewer.userId) === String(item.suggestion?.userId);
}

// Which copy a list or grid may show. Only the card's own page ever gets the normal copy of an
// 18+ poster, and only behind a button.
function gridPosterUrl(item) {
  if (!item.poster) return null;
  return item.nsfw ? item.poster.blurUrl : item.poster.url;
}

module.exports = {
  encodePoster,
  savePoster,
  deletePoster,
  gridPosterUrl,
  isPosterVisible,
  POSTER_WIDTH,
  BLUR_WIDTH,
};
