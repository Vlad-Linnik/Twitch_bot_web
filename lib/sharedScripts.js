// Files that live outside public/ but are also served to the browser, as they are.
//
// lib/variableTemplate.js is the template grammar the bot renders with (its copy is
// TwitchBot/shared/variableTemplate.js). The server validates a command's text with it, and the
// command editor in the browser draws chips and the preview with it. Serving the one file under a
// public URL, instead of keeping a second copy in public/js/, means the editor and the validator
// cannot disagree: there is nothing to keep in sync. The file is written to work both ways - it
// assigns module.exports under Node and window.VariableTemplate in a plain <script>.
//
// Only paths listed here are served; nothing is resolved from the request.
const path = require("path");

const SHARED_SCRIPTS = {
  "/js/shared/variable-template.js": path.join(__dirname, "variableTemplate.js"),
};

// Same caching rule as express.static in app.js: a year and immutable when the URL carries the
// ?v= fingerprint lib/assetVersion.js stamps on, an hour otherwise.
function sharedScriptsMiddleware(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const file = SHARED_SCRIPTS[req.path];
  if (!file) return next();
  const versioned = req.query && req.query.v;
  res.sendFile(file, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    },
  }, (err) => {
    if (err) next(err);
  });
}

module.exports = { SHARED_SCRIPTS, sharedScriptsMiddleware };
