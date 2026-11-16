// The crop of a media card's cover (lib/mediaImage.js stores the files, this decides which part of
// them a tile shows). Pure arithmetic, kept apart from the sharp-backed module so it can be used and
// tested without it.
//
// The stored files are the whole picture; what a tile shows of it is a crop rectangle kept next to
// them (`poster.crop`), drawn by CSS (posterCropStyle). Nothing is cut out of the file, so the crop
// can be changed any number of times - on an automatic cover too - without losing a pixel, and the
// blurred copy (same proportions) takes the same rectangle. No crop = the old behaviour, the middle
// of the picture (object-cover).
//
// {x, y, w, h}: fractions of the picture's width and height. The rectangle always has the frame's
// proportions (`aspect` = width / height, 2/3 for films, 3/4 for games): normalizeCrop derives h
// from w for the picture's own proportions, so a stretched picture cannot be stored whatever the
// form sends.
const CROP_MIN = 0.05;
const round4 = (n) => Math.round(n * 10000) / 10000;

// "x,y,w,h" from the form -> numbers, or null (empty, malformed or out of range).
function parseCrop(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = raw.split(",").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w] = parts;
  if (x < 0 || y < 0 || w < CROP_MIN || w > 1 || x > 1 || y > 1) return null;
  return { x, y, w };
}

// The crop for a picture of `width` x `height` pixels in a frame of `aspect`, moved and shrunk into
// the picture if it hangs over an edge; null without a crop or the picture's size.
function normalizeCrop(crop, { width, height }, aspect) {
  if (!crop || !(width > 0) || !(height > 0) || !(aspect > 0)) return null;
  const ratio = width / height;
  // The widest rectangle of the frame's proportions that fits in the picture.
  const maxW = Math.min(1, aspect / ratio);
  let w = Math.min(Math.max(crop.w, CROP_MIN), maxW);
  let h = (w * ratio) / aspect;
  if (h > 1) {
    h = 1;
    w = aspect / ratio;
  }
  const x = Math.min(Math.max(crop.x, 0), 1 - w);
  const y = Math.min(Math.max(crop.y, 0), 1 - h);
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

// Inline style for the <img> inside a frame of the crop's proportions (position: absolute in a
// relative, overflow-hidden box): scaled so the rectangle fills the frame, shifted so it is the
// part on show. Empty string for no crop - the caller keeps object-cover.
function posterCropStyle(crop) {
  if (!crop || !(crop.w > 0) || !(crop.h > 0)) return "";
  const pct = (n) => `${round4(n * 100)}%`;
  return `width:${pct(1 / crop.w)};height:${pct(1 / crop.h)};left:${pct(-crop.x / crop.w)};top:${pct(-crop.y / crop.h)};max-width:none;`;
}

module.exports = { parseCrop, normalizeCrop, posterCropStyle };
