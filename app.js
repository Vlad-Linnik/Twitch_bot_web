const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const env = require("./config/env");
const createSessionMiddleware = require("./middleware/session");
const attachUser = require("./middleware/auth");
const i18nMiddleware = require("./middleware/i18n");
const navMenuMiddleware = require("./middleware/navMenu");
const csrf = require("./middleware/csrf");
const siteVisits = require("./middleware/siteVisits");
const safeJson = require("./lib/safeJson");

function createApp() {
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
  app.use(express.static(path.join(__dirname, "public")));
  app.use(siteVisits);
  app.use(express.urlencoded({ extended: false }));
  app.use(createSessionMiddleware());
  app.use(attachUser);
  app.use(i18nMiddleware);
  app.use(navMenuMiddleware);
  app.use(csrf.ensureToken);
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
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