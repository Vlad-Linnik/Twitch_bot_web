const express = require("express");
const helmet = require("helmet");
const path = require("path");
const env = require("./config/env");
const createSessionMiddleware = require("./middleware/session");
const attachUser = require("./middleware/auth");
const csrf = require("./middleware/csrf");

function createApp() {
  const app = express();

  if (env.isProduction) app.set("trust proxy", 1);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  // HSTS unconditionally tells browsers to force HTTPS on future visits, which
  // would break plain-HTTP local dev - only send it once we're actually in production.
  app.use(helmet({ hsts: env.isProduction }));
  app.use(express.static(path.join(__dirname, "public")));
  app.use(express.urlencoded({ extended: false }));
  app.use(createSessionMiddleware());
  app.use(attachUser);
  app.use(csrf.ensureToken);

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