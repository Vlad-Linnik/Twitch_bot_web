// Cache-busting fingerprints for files under public/, so express.static can serve them with a
// one-year immutable Cache-Control instead of the max-age=0 it defaults to.
//
// Why this exists: every navigation used to re-validate public/css/output.css (84KB, and
// render-blocking) plus each page's <script>s - one conditional round-trip apiece, serialized
// ahead of the new document's first paint. That directly delays the cross-document view
// transition, which waits on exactly that first paint (see views/partials/head.ejs). With a
// fingerprinted URL the browser skips the network entirely.
//
// The fingerprint is mtime+size, not a content hash: it's derived from a single statSync, it
// changes on every rebuild/deploy, and nothing here needs to be collision-resistant against an
// attacker - only different-after-an-edit.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Deliberately NOT memoized, in either environment. Both ways of writing public/css/output.css
// happen while the Express process is already running - `npm run dev:css` in watch mode locally,
// and `npm run build:css` during a deploy (nodemon watches server code, not public/, and there
// is no ordering rule that can make systemd restart land after the CSS build reliably). A cached
// fingerprint would then keep serving the OLD ?v= for a file whose contents changed, and every
// browser that already fetched that URL has it pinned for a year behind `immutable` - the exact
// failure this module exists to prevent, made permanent. A statSync is a few microseconds
// against an OS-cached inode, on ~5 assets per render; that is not worth trading for the trap.
function fingerprint(urlPath) {
  let version = null;
  try {
    // urlPath is always a literal written in a view, never user input, but resolve-and-verify
    // anyway so a future caller can't walk out of public/ with a "/../".
    const abs = path.join(PUBLIC_DIR, urlPath);
    if (abs.startsWith(PUBLIC_DIR)) {
      const stat = fs.statSync(abs);
      version = crypto
        .createHash("sha1")
        .update(`${stat.mtimeMs}:${stat.size}`)
        .digest("hex")
        .slice(0, 8);
    }
  } catch {
    // Missing file: fall through to an unversioned URL. express.static will 404 it just as it
    // would have before, rather than this helper turning a broken path into a crashed render.
    version = null;
  }

  return version;
}

// res.locals.asset() - "/css/output.css" -> "/css/output.css?v=1a2b3c4d"
function asset(urlPath) {
  const version = fingerprint(urlPath);
  return version ? `${urlPath}?v=${version}` : urlPath;
}

module.exports = { asset };
