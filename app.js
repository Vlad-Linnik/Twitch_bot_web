const express = require("express");
const helmet = require("helmet");
const path = require("path");
const env = require("./config/env");
const createSessionMiddleware = require("./middleware/session");
const attachUser = require("./middleware/auth");
const i18nMiddleware = require("./middleware/i18n");
const navMenuMiddleware = require("./middleware/navMenu");
const csrf = require("./middleware/csrf");

function createApp() {
  const app = express();

  if (env.isProduction) app.set("trust proxy", 1);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  // HSTS unconditionally tells browsers to force HTTPS on future visits, which
  // would break plain-HTTP local dev - only send it once we're actually in production.
  // referrerPolicy: helmet defaults to "no-referrer", which also zeroes out
  // document.referrer on the landed page (not just the network header) - that
  // breaks public/js/page-transitions.js's same-origin from/to comparison.
  // "same-origin" still sends nothing to cross-origin destinations, just
  // restores it for navigation within this site.
  app.use(helmet({ hsts: env.isProduction, referrerPolicy: { policy: "same-origin" } }));
  app.use(express.static(path.join(__dirname, "public")));
  app.use(express.urlencoded({ extended: false }));
  app.use(createSessionMiddleware());
  app.use(attachUser);
  app.use(i18nMiddleware);
  app.use(navMenuMiddleware);
  app.use(csrf.ensureToken);
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
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