// Open-Meteo for the OBS weather widget: the city search on the setup page and the current
// conditions the overlay polls. Key-free; the bot's !weather uses the same service
// (TwitchBot/twitch/weather.js, which explains why it is not wttr.in).
//
// The overlay of every channel asks this server, never Open-Meteo directly: a browser source in
// OBS polls for as long as the scene exists, so readings are cached per place here and a city
// shown by several channels - or by one channel in several scenes - costs one request per
// CURRENT_TTL_MS. Concurrent misses for one place share one request.
const axios = require("axios");
const { parseCity } = require("./weatherWidget");

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 8000;

// Open-Meteo refreshes current conditions every 15 minutes; asking more often returns the same
// numbers.
const CURRENT_TTL_MS = 10 * 60 * 1000;
// A failed fetch is not retried by every poller at once: the place stays "failed" this long.
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map(); // "lat,lon" -> { at, value, error }
const inflight = new Map();

function placeKey(lat, lon) {
  return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
}

// Up to `count` places for a typed name, in the setup page's language.
async function searchCities(query, { lang = "ru", count = 6 } = {}) {
  const name = String(query || "").trim().slice(0, 80);
  if (name.length < 2) return [];
  const { data } = await axios.get(GEOCODE_URL, {
    params: { name, count, language: lang === "en" ? "en" : "ru", format: "json" },
    timeout: TIMEOUT_MS,
  });
  const results = Array.isArray(data && data.results) ? data.results : [];
  return results.map(parseCity).filter(Boolean);
}

async function fetchCurrent(lat, lon) {
  const { data } = await axios.get(FORECAST_URL, {
    params: {
      latitude: lat,
      longitude: lon,
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m",
      wind_speed_unit: "kmh",
      timezone: "auto",
    },
    timeout: TIMEOUT_MS,
  });
  if (!data || !data.current) throw new Error("no current block in the answer");
  return data.current;
}

function remember(key, entry) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
}

// Open-Meteo's `current` block for a place, from the cache when fresh. Throws when the service
// failed and nothing fresh is cached; a stale reading is returned rather than an error, because a
// widget showing the weather of twenty minutes ago is better than one showing nothing.
async function currentConditions(lat, lon) {
  const key = placeKey(lat, lon);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.value && now - hit.at < CURRENT_TTL_MS) return hit.value;
  if (hit && hit.error && now - hit.at < FAILURE_TTL_MS) {
    if (hit.value) return hit.value;
    throw hit.error;
  }
  if (inflight.has(key)) return inflight.get(key);
  const request = fetchCurrent(lat, lon)
    .then((value) => {
      remember(key, { at: Date.now(), value });
      return value;
    })
    .catch((error) => {
      const stale = hit && hit.value;
      remember(key, { at: Date.now(), value: stale || null, error });
      if (stale) return stale;
      throw error;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

module.exports = { searchCities, currentConditions, CURRENT_TTL_MS };
