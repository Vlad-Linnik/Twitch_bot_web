const crypto = require("crypto");
const compression = require("compression");
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const env = require("./config/env");
const { asset } = require("./lib/assetVersion");
const attachUser = require("./middleware/auth");
const i18nMiddleware = require("./middleware/i18n");
const navMenuMiddleware = require("./middleware/navMenu");
const csrf = require("./middleware/csrf");
const siteVisits = require("./middleware/siteVisits");
const safeJson = require("./lib/safeJson");

// sessionMiddleware is built once in index.js and passed in, rather than each
// constructed here, so realtime/socketServer.js's WebSocket upgrade handler
// can run requests through the exact same express-session instance (same
// MongoStore connection, same secret) to recover req.session for an
// authenticated WS connection - two independently-constructed instances would
// have identical config but not literally be "the same session store handle".
function createApp(sessionMiddleware) {
  const app = express();

  if (env.isProduction) app.set("trust proxy", 1);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  // Per-request CSP nonce for the two inline <script>s in views/partials/head.ejs.
  // Must be mounted BEFORE helmet: its script-src directive function reads this
  // res.locals value at response time.
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
    next();
  });
  // HSTS unconditionally tells browsers to force HTTPS on future visits, which
  // would break plain-HTTP local dev - only send it once we're actually in production.
  // referrerPolicy: helmet defaults to "no-referrer", which also zeroes out
  // document.referrer on the landed page (not just the network header) - that
  // breaks public/js/page-transitions.js's same-origin from/to comparison.
  // "same-origin" still sends nothing to cross-origin destinations, just
  // restores it for navigation within this site.
  // contentSecurityPolicy: helmet's default img-src is 'self' data:, which blocks
  // Twitch avatars/emotes (static-cdn.jtvnw.net) and 7TV emotes (cdn.7tv.app) -
  // allow exactly those two CDNs. script-src gets the per-request nonce instead
  // of 'unsafe-inline' so head.ejs's inline scripts run without opening CSP up.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "img-src": ["'self'", "data:", "https://static-cdn.jtvnw.net", "https://cdn.7tv.app"],
          "script-src": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        },
      },
      hsts: env.isProduction,
      referrerPolicy: { policy: "same-origin" },
    })
  );
  // Nothing was compressed before this: neither here nor in deploy/Caddyfile.example (a bare
  // `reverse_proxy` does not encode). Measured on the real pages - output.css 84KB -> 15KB,
  // /commands 48KB -> 5.9KB, a channel's /statistics/chat 20KB -> 4.6KB. That HTML sits in the
  // critical path of every navigation, and the cross-document view transition waits on the new
  // document's first paint, so this is the single largest lever on how often the slide plays
  // at all. Done in Node rather than at Caddy on purpose - it ships with the app and holds
  // regardless of what's proxying in front of it (see deploy/Caddyfile.example).
  app.use(compression());

  // maxAge/immutable only bind when the request carries the ?v= fingerprint that
  // lib/assetVersion.js's res.locals.asset() stamps onto the URL. Views go through that helper
  // for css/js; the games' sprites and sounds are built as URL strings inside client JS and
  // arrive unversioned, so those fall to a plain one-hour max-age - still an enormous
  // improvement on the previous max-age=0 (public/sounds alone is 7.2MB, re-validated on every
  // single game load), while staying short enough that an unversioned asset self-heals.
  app.use(
    express.static(path.join(__dirname, "public"), {
      setHeaders(res) {
        const versioned = res.req.query && res.req.query.v;
        res.setHeader(
          "Cache-Control",
          versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600"
        );
      },
    })
  );
  app.use(siteVisits);
  // Every route parses bodies at express.urlencoded's 100kB default EXCEPT the
  // game replay endpoints, which carry a base64 input log that can reach a few
  // hundred kB on a marathon run (see replayCodec.js's LIMITS). Those two
  // paths are skipped here and mount their own higher-limit parser inside
  // routes/games.js instead - raising the ceiling globally would hand every
  // route on a 2GB VPS a 384kB attacker-controlled buffer to defend.
  const replayBodyPath = /^\/games\/[^/]+\/(score|run\/checkpoint)\.json$/;
  const defaultUrlencoded = express.urlencoded({ extended: false });
  app.use((req, res, next) =>
    replayBodyPath.test(req.path) ? next() : defaultUrlencoded(req, res, next)
  );
  app.use(sessionMiddleware);
  app.use(attachUser);
  app.use(i18nMiddleware);
  app.use(navMenuMiddleware);
  app.use(csrf.ensureToken);
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    // Stamps ?v=<fingerprint> onto a public/ URL so express.static above can answer it with a
    // one-year immutable Cache-Control. Every <link>/<script> in views/ goes through this.
    res.locals.asset = asset;
    // Includes the query string (unlike currentPath) - every "Login with Twitch" link uses this
    // as its ?returnTo= so routes/authRoutes.js's /callback can land the visitor back on the
    // exact page (filters, pagination, etc. included) that sent them to log in.
    res.locals.currentUrl = req.originalUrl;
    // Views inline server-fetched data into <script> tags; that data contains chat-derived
    // strings, so it must never go through a bare JSON.stringify(). See lib/safeJson.js.
    res.locals.safeJson = safeJson;
    next();
  });

  app.use("/", require("./routes"));

  app.use((req, res) => {
    res.status(404).render("errors/404");
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[app] Unhandled error:", err);
    res.status(500).render("errors/500");
  });

  return app;
}

module.exports = createApp;