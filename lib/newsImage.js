// Hero-image processing for admin-authored news posts (routes/admin.js's create/edit
// handlers, fed by multer's in-memory buffer). Re-encodes to webp and caps the width so a
// multi-megabyte phone photo doesn't sit on the 2GB VPS at full size - the card layout
// (views/partials/newsCard.ejs) never needs more than this either way. sharp itself is the
// validation: it throws on anything that isn't decodable image data, which the caller turns
// into a 400.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads", "news");
const MAX_WIDTH = 1920;
const WEBP_QUALITY = 82;

async function saveNewsImage(buffer) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const outputBuffer = await sharp(buffer)
    .rotate() // auto-orients from EXIF, then strips it - the re-encode below drops all other metadata too
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
  const { width, height } = await sharp(outputBuffer).metadata();

  const filename = `${crypto.randomUUID()}.webp`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), outputBuffer);

  return { url: `/uploads/news/${filename}`, width, height };
}

// Best-effort - called from delete/replace-image flows. path.basename() drops any directory
// component a malformed stored URL might contain, so this can never escape UPLOAD_DIR.
async function deleteNewsImage(url) {
  if (!url || !url.startsWith("/uploads/news/")) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(url));
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[newsImage] failed to delete", filePath, err.message);
  }
}

module.exports = { saveNewsImage, deleteNewsImage };
