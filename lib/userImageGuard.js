// The barrier between a viewer's uploaded cover and every other visitor's browser.
//
// The rule: the original file is never stored and never served. It is decoded and a new image is
// encoded from the pixels (lib/mediaImage.js's savePoster), so not one byte of the upload reaches
// anyone - which closes polyglots ("image + HTML/archive"), scripts, metadata (a phone's EXIF GPS
// included) and payloads aimed at a viewer's image decoder. No antivirus: a signature database the
// size of the site's whole memory budget, which is weak against images anyway, buys less than this.
//
// The steps run cheapest first, each one before the next can cost anything:
//   1. the upload is held in memory with a byte ceiling (multer, in the route);
//   2. the first bytes must be JPEG, PNG or WebP - the name and Content-Type the browser sent are
//      never read; SVG, GIF, HTML and everything else stop here;
//   3. the header alone (sharp().metadata(), no pixel decoding): format agrees with the magic bytes,
//      a single page (no animation), each side at most MAX_SIDE, at most MAX_PIXELS in all - a
//      "decompression bomb" is refused before memory is set aside for its pixels;
//   4. the re-encode itself runs with the same pixel ceiling and failOn "error", so a truncated or
//      corrupt file is a form error, not a half-picture.
// And around all of it, the VPS: one viewer upload is processed at a time and up to QUEUE_MAX more
// wait; past that the upload is refused as "busy" (503, try in a minute). Moderators' and the
// admin's uploads do not queue - they are few, and they are trusted.
const sharp = require("sharp");

const MAX_SIDE = 6000;
const MAX_PIXELS = 16_000_000;
const QUEUE_MAX = 3;

// Options for the re-encode (lib/mediaImage.js's savePoster): the same pixel ceiling the header
// check applied, and a hard failure on any decode error rather than sharp's default warning.
const STRICT_SHARP_OPTIONS = Object.freeze({ limitInputPixels: MAX_PIXELS, failOn: "error", animated: false });

class UserImageError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// The format by its first bytes, or null. Only what the barrier lets through.
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

// Steps 2 and 3. Throws UserImageError; resolves to the header's {format, width, height}.
async function inspectUserImage(buf, { sharpImpl = sharp } = {}) {
  const sniffed = sniffImageType(buf);
  if (!sniffed) throw new UserImageError("not_allowed_type");
  let meta;
  try {
    meta = await sharpImpl(buf, { limitInputPixels: false }).metadata();
  } catch {
    throw new UserImageError("unreadable");
  }
  if (meta.format !== sniffed) throw new UserImageError("type_mismatch");
  if ((meta.pages || 1) > 1) throw new UserImageError("animated");
  const { width, height } = meta;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new UserImageError("unreadable");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new UserImageError("too_large");
  return { format: meta.format, width, height };
}

// One-at-a-time processing with a short queue. `run(task)` resolves with the task's result, or
// rejects with UserImageError("busy") when the queue is full - the caller answers 503.
function createUploadGate({ concurrency = 1, queueMax = QUEUE_MAX } = {}) {
  let active = 0;
  const waiting = [];

  function next() {
    if (active >= concurrency || waiting.length === 0) return;
    const { task, resolve, reject } = waiting.shift();
    active++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return {
    run(task) {
      if (active >= concurrency && waiting.length >= queueMax) {
        return Promise.reject(new UserImageError("busy"));
      }
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        next();
      });
    },
    get pending() {
      return active + waiting.length;
    },
  };
}

module.exports = {
  MAX_SIDE,
  MAX_PIXELS,
  QUEUE_MAX,
  STRICT_SHARP_OPTIONS,
  UserImageError,
  sniffImageType,
  inspectUserImage,
  createUploadGate,
};
