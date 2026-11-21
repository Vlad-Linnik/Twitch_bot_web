// OBS widgets that are not donation media (that one has its own routes/donationMedia.js, and both
// sit under the "Widgets" category of the settings panel - lib/settingsNav.js).
//
//   /:channel/settings/widgets/weather           the owner's weather widget setup: city, look,
//                                                 animations, and the OBS link. Level 1 - the
//                                                 city is the streamer's whereabouts.
//   /:channel/settings/widgets/weather/cities    the setup page's city search (JSON)
//   /obs/weather/:key                            the OBS browser source (no login: the key is
//   /obs/weather/:key/data                       the credential) and the reading it polls
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const weatherWidgetRepo = require("../db/weatherWidgetRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel } = require("../middleware/permissions");
const { settingsNav } = require("../middleware/settingsNav");
const { settingsWriteLimiter, searchLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const weather = require("../lib/weatherWidget");
const openMeteo = require("../lib/openMeteo");

const router = express.Router();

// The overlay is a transparent page composited over the stream: our own script and styles, no
// third-party anything. It may be framed by the site itself - the setup page shows it live.
const OBS_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

function overlayLink(req, key) {
  // ?lang= pins the overlay to the owner's language - OBS's browser has no account to ask.
  return `${req.protocol}://${req.get("host")}/obs/weather/${key}?lang=${encodeURIComponent(req.locale || "en")}`;
}

// Everything the overlay script needs that is not the live reading: the scene of every code,
// the descriptions in the page's language, the labels. One JSON in a data attribute.
function overlayBootstrap(t, config) {
  const descriptions = Object.fromEntries(weather.CODES.map((code) => [code, t(`weatherWidget.code.${code}`)]));
  return {
    scenes: weather.SCENES,
    descriptions,
    strings: {
      feels: t("weatherWidget.overlay.feels"),
      wind: t("weatherWidget.overlay.wind"),
      windUnitC: t("weatherWidget.overlay.windKmh"),
      windUnitF: t("weatherWidget.overlay.windMph"),
      humidity: t("weatherWidget.overlay.humidity"),
      noCity: t("weatherWidget.overlay.noCity"),
      unavailable: t("weatherWidget.overlay.unavailable"),
    },
    settings: config.settings,
    city: weather.publicCityName(config),
  };
}

router.get("/:channel/settings/widgets/weather", requireLevel(1), settingsNav("weatherWidget"), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;
    const config = await weatherWidgetRepo.getOrCreate(channel);
    res.render("weatherWidgetSetup", {
      channel,
      config,
      cityLabel: weather.cityLabel(config.city),
      // The setup page is the owner's: its preview may show the name even while the widget hides it.
      cityName: config.city ? config.city.name : "",
      link: overlayLink(req, config.key),
      previewCodes: weather.PREVIEW_CODES,
      saved: ["settings", "link"].includes(req.query.saved) ? req.query.saved : null,
      error: req.query.error === "city" || req.query.error === "cityLookup" ? req.query.error : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:channel/settings/widgets/weather/cities", searchLimiter, requireLevel(1), async (req, res) => {
  try {
    const results = await openMeteo.searchCities(req.query.q, { lang: req.locale });
    res.json({ results: results.map((city) => ({ ...city, label: weather.cityLabel(city) })) });
  } catch (err) {
    console.error("[widgets] city search failed:", err.message);
    res.status(502).json({ results: [], error: "lookup" });
  }
});

router.post("/:channel/settings/widgets/weather", settingsWriteLimiter, requireLevel(1), verifyToken, async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;
    const config = await weatherWidgetRepo.getOrCreate(channel);
    const back = `/${channel.channelLogin}/settings/widgets/weather`;
    const log = (action, target, before, after) =>
      settingsChangeLogRepo.logChange({ channelLogin: channel.channelLogin, user: req.user, category: "weather_widget", action, target, before, after });

    if (req.body.action === "regenerate") {
      await weatherWidgetRepo.regenerateKey(channel.channelId);
      await log("regenerate", "link", null, null);
      return res.redirect(`${back}?saved=link#link`);
    }

    // The city: the place picked from the search (hidden fields), or - without JS, or when the
    // owner typed a name and saved without picking - the search's first hit. An untouched name
    // keeps the stored city.
    const query = String(req.body.cityQuery || "").trim();
    let city = null;
    if (req.body.cityLat !== undefined && req.body.cityLat !== "") {
      city = weather.parseCity({
        name: req.body.cityName,
        admin1: req.body.cityAdmin1,
        country: req.body.cityCountry,
        lat: req.body.cityLat,
        lon: req.body.cityLon,
      });
      if (!city) return res.redirect(`${back}?error=city#city`);
    } else if (query && query !== weather.cityLabel(config.city)) {
      let found;
      try {
        found = await openMeteo.searchCities(query, { lang: req.locale, count: 1 });
      } catch (err) {
        console.error("[widgets] city lookup on save failed:", err.message);
        return res.redirect(`${back}?error=cityLookup#city`);
      }
      if (!found.length) return res.redirect(`${back}?error=city#city`);
      city = found[0];
    }

    const settings = weather.parseSettings(req.body);
    await weatherWidgetRepo.save(channel.channelId, { settings, city });
    // That the city changed, never which one: moderators read the journal, and the city is the
    // streamer's whereabouts - the reason this page is the owner's alone.
    if (city && weather.cityLabel(city) !== weather.cityLabel(config.city)) {
      await log("update", "city", null, null);
    }
    if (JSON.stringify(settings) !== JSON.stringify(config.settings)) {
      await log("update", "settings", null, null);
    }
    return res.redirect(`${back}?saved=settings`);
  } catch (err) {
    next(err);
  }
});

// --- OBS ---------------------------------------------------------------------------------------

function obsHeaders(res) {
  res.setHeader("Content-Security-Policy", OBS_CSP);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
}

router.get("/obs/weather/:key", async (req, res, next) => {
  try {
    const config = await weatherWidgetRepo.findByKey(req.params.key);
    if (!config) return res.status(404).type("text/plain").send("Not found");
    obsHeaders(res);
    res.render("weatherWidget", {
      key: req.params.key,
      channelLogin: config.channelLogin,
      bootstrap: overlayBootstrap(res.locals.t, config),
    });
  } catch (err) {
    next(err);
  }
});

// The reading the overlay polls. Its settings ride along, so a change on the setup page reaches
// a running OBS scene on the next poll without the streamer reloading the source.
router.get("/obs/weather/:key/data", async (req, res) => {
  obsHeaders(res);
  try {
    const config = await weatherWidgetRepo.findByKey(req.params.key);
    if (!config) return res.status(404).json({ error: "notFound" });
    const base = { settings: config.settings, city: weather.publicCityName(config) };
    if (!config.city) return res.json({ ...base, reading: null, error: "noCity" });
    try {
      const current = await openMeteo.currentConditions(config.city.lat, config.city.lon);
      const reading = weather.toReading(current, config.settings.units);
      return res.json({ ...base, reading, error: reading ? null : "unavailable" });
    } catch (err) {
      console.error("[widgets] weather fetch failed:", err.message);
      return res.json({ ...base, reading: null, error: "unavailable" });
    }
  } catch (err) {
    console.error("[widgets] weather data failed:", err.message);
    res.status(500).json({ error: "unavailable" });
  }
});

module.exports = router;
