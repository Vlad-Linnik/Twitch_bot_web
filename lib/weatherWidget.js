// The OBS weather widget (routes/widgets.js): what a weather code looks like, which settings a
// channel may have, and how a forecast answer becomes the small reading the overlay draws.
// Pure - the network half is lib/openMeteo.js.
//
// Weather codes are WMO's (0-99) as Open-Meteo reports them - the same table the bot's !weather
// uses (TwitchBot/twitch/weather.js). The overlay never sees a code table of its own: the scene
// for every code is rendered into the page from SCENES below, so the picture for a live reading
// and for a preview button come from one place.

// A scene is a set of layer strengths the overlay eases between, which is what turns "clear" into
// "rain" as clouds rolling in, the sky darkening and the first drops, rather than one icon
// replacing another:
//   sun     0..1  how much of the sun (the moon at night) shows through
//   clouds  0..1  cloud cover - 0 none, 1 the whole sky; more cover slides more clouds in
//   dark    0..1  how heavy the clouds look
//   rain    0..1  rain intensity
//   snow    0..1  snow intensity
//   storm   0|1   lightning
//   fog     0..1  fog banks
// `group` is the coarse condition, for the preview buttons and the description fallback.
function scene(group, { sun = 0, clouds = 0, dark = 0, rain = 0, snow = 0, storm = 0, fog = 0 } = {}) {
  return { group, sun, clouds, dark, rain, snow, storm, fog };
}

const SCENES = {
  0: scene("clear", { sun: 1 }),
  1: scene("mainlyClear", { sun: 1, clouds: 0.25 }),
  2: scene("partlyCloudy", { sun: 0.85, clouds: 0.55, dark: 0.05 }),
  3: scene("cloudy", { sun: 0, clouds: 1, dark: 0.3 }),
  45: scene("fog", { sun: 0.25, clouds: 0.35, dark: 0.1, fog: 1 }),
  48: scene("fog", { sun: 0.2, clouds: 0.35, dark: 0.15, fog: 1 }),
  51: scene("drizzle", { sun: 0.2, clouds: 0.8, dark: 0.35, rain: 0.2 }),
  53: scene("drizzle", { sun: 0.1, clouds: 0.85, dark: 0.4, rain: 0.3 }),
  55: scene("drizzle", { clouds: 0.9, dark: 0.45, rain: 0.42 }),
  56: scene("drizzle", { clouds: 0.85, dark: 0.4, rain: 0.25, snow: 0.12 }),
  57: scene("drizzle", { clouds: 0.9, dark: 0.5, rain: 0.4, snow: 0.18 }),
  61: scene("rain", { clouds: 1, dark: 0.5, rain: 0.5 }),
  63: scene("rain", { clouds: 1, dark: 0.6, rain: 0.72 }),
  65: scene("rain", { clouds: 1, dark: 0.75, rain: 1 }),
  66: scene("rain", { clouds: 1, dark: 0.55, rain: 0.5, snow: 0.2 }),
  67: scene("rain", { clouds: 1, dark: 0.7, rain: 0.85, snow: 0.25 }),
  71: scene("snow", { clouds: 1, dark: 0.25, snow: 0.4 }),
  73: scene("snow", { clouds: 1, dark: 0.3, snow: 0.7 }),
  75: scene("snow", { clouds: 1, dark: 0.4, snow: 1 }),
  77: scene("snow", { clouds: 0.9, dark: 0.3, snow: 0.35 }),
  80: scene("rain", { sun: 0.35, clouds: 0.85, dark: 0.5, rain: 0.55 }),
  81: scene("rain", { sun: 0.15, clouds: 0.95, dark: 0.65, rain: 0.8 }),
  82: scene("rain", { clouds: 1, dark: 0.8, rain: 1 }),
  85: scene("snow", { sun: 0.15, clouds: 0.9, dark: 0.3, snow: 0.6 }),
  86: scene("snow", { clouds: 1, dark: 0.45, snow: 1 }),
  95: scene("storm", { clouds: 1, dark: 0.9, rain: 0.8, storm: 1 }),
  96: scene("storm", { clouds: 1, dark: 0.9, rain: 0.85, storm: 1 }),
  99: scene("storm", { clouds: 1, dark: 0.95, rain: 1, storm: 1 }),
};

const CODES = Object.keys(SCENES).map(Number);

// A code Open-Meteo may add later reads as overcast rather than as nothing at all.
function sceneFor(code) {
  return SCENES[code] || SCENES[3];
}

// The preview buttons on the setup page: one representative code per condition, with a
// plausible temperature so the preview does not show 24° over a snowfall.
const PREVIEW_CODES = [
  { key: "clear", code: 0, isDay: true, temp: 24 },
  { key: "partlyCloudy", code: 2, isDay: true, temp: 19 },
  { key: "cloudy", code: 3, isDay: true, temp: 14 },
  { key: "fog", code: 45, isDay: true, temp: 8 },
  { key: "drizzle", code: 53, isDay: true, temp: 11 },
  { key: "rain", code: 63, isDay: true, temp: 12 },
  { key: "heavyRain", code: 82, isDay: true, temp: 15 },
  { key: "storm", code: 95, isDay: true, temp: 22 },
  { key: "snow", code: 73, isDay: true, temp: -5 },
  { key: "night", code: 0, isDay: false, temp: 9 },
  { key: "nightRain", code: 61, isDay: false, temp: 7 },
];

// --- settings ----------------------------------------------------------------------------------

const STYLES = ["minimal", "realistic"];
const UNITS = ["c", "f"];

// What the widget can show, each switched on or off on its own. The overlay lays itself out from
// whichever are on (public/js/weather-widget.js's layout classes), so any combination is a
// finished picture rather than a card with holes in it.
const FIELDS = ["icon", "temp", "desc", "city", "feels", "wind", "humidity"];
const DEFAULT_SHOW = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f, true])));
// Ticking nothing at all would leave an empty source in OBS; it reads as the two essentials.
const FALLBACK_SHOW = Object.freeze(Object.fromEntries(FIELDS.map((f) => [f, f === "icon" || f === "temp"])));

const DEFAULT_SETTINGS = Object.freeze({
  style: "realistic",
  animations: true, // moving weather: drifting clouds, falling rain, turning sun
  transitions: true, // a change of weather is played out instead of swapped
  units: "c",
  // No card and no sky box in the realistic look: sun, clouds and rain straight over the stream.
  // The minimal look has no background either way.
  transparent: false,
  show: DEFAULT_SHOW,
});

const MAX_NAME_LENGTH = 80;

function cleanText(value, max = MAX_NAME_LENGTH) {
  if (typeof value !== "string") return "";
  // Control characters and the bidi overrides are not a city name, and the label is drawn on stream.
  return value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, max);
}

function finiteIn(value, min, max) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) && String(value ?? "").trim() !== "" && n >= min && n <= max ? n : null;
}

// One geocoder hit (Open-Meteo's /search result, or the setup form's hidden fields that carry one)
// as a stored city, or null when it is not a usable place.
function parseCity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanText(raw.name);
  const lat = finiteIn(raw.latitude ?? raw.lat, -90, 90);
  const lon = finiteIn(raw.longitude ?? raw.lon, -180, 180);
  if (!name || lat === null || lon === null) return null;
  const city = {
    name,
    lat: Math.round(lat * 10000) / 10000,
    lon: Math.round(lon * 10000) / 10000,
  };
  const admin1 = cleanText(raw.admin1);
  const country = cleanText(raw.country);
  if (admin1 && admin1 !== name) city.admin1 = admin1;
  if (country) city.country = country;
  return city;
}

// "Москва, Россия" - what the setup page shows to tell two places with one name apart.
function cityLabel(city) {
  if (!city) return "";
  return [city.name, city.admin1, city.country].filter(Boolean).join(", ");
}

function checkbox(value) {
  return value === "1" || value === "on" || value === true;
}

// The settings half of the setup form. Absent checkboxes are "off" - that is how a form posts them.
function parseSettings(body = {}) {
  return {
    style: STYLES.includes(body.style) ? body.style : DEFAULT_SETTINGS.style,
    animations: checkbox(body.animations),
    transitions: checkbox(body.transitions),
    units: UNITS.includes(body.units) ? body.units : DEFAULT_SETTINGS.units,
    transparent: checkbox(body.transparent),
    show: parseShow(body),
  };
}

// The "what to show" checkboxes, posted as show_<field>.
function parseShow(body = {}) {
  const show = Object.fromEntries(FIELDS.map((f) => [f, checkbox(body[`show_${f}`])]));
  return FIELDS.some((f) => show[f]) ? show : { ...FALLBACK_SHOW };
}

// A stored row's settings with the defaults under it, so a field added later has a value on rows
// written before it.
function withDefaults(stored = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key !== "show" && stored[key] !== undefined && stored[key] !== null) out[key] = stored[key];
  }
  if (!STYLES.includes(out.style)) out.style = DEFAULT_SETTINGS.style;
  if (!UNITS.includes(out.units)) out.units = DEFAULT_SETTINGS.units;
  // Rows saved before the per-field choice carry two switches instead: `details` (feels-like,
  // wind and humidity together) and `showCity`.
  const show = { ...DEFAULT_SHOW };
  if (stored.details === false) show.feels = show.wind = show.humidity = false;
  if (stored.showCity === false) show.city = false;
  if (stored.show && typeof stored.show === "object") {
    for (const f of FIELDS) if (typeof stored.show[f] === "boolean") show[f] = stored.show[f];
  }
  out.show = FIELDS.some((f) => show[f]) ? show : { ...FALLBACK_SHOW };
  return out;
}

// --- readings ----------------------------------------------------------------------------------

function cToF(c) {
  return (c * 9) / 5 + 32;
}

// Open-Meteo's `current` block (asked for in Celsius and km/h) as what the overlay draws, in the
// channel's units. Null when the answer does not carry the two things the widget cannot do
// without: a temperature and a weather code.
function toReading(current, units = "c") {
  if (!current || typeof current !== "object") return null;
  // Numbers only: Number(null) is 0, and a missing temperature must not read as 0°.
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const temp = num(current.temperature_2m);
  const code = num(current.weather_code);
  if (!Number.isFinite(temp) || !Number.isInteger(code)) return null;
  const feels = num(current.apparent_temperature);
  const wind = num(current.wind_speed_10m);
  const humidity = num(current.relative_humidity_2m);
  const f = units === "f";
  const temperature = (c) => Math.round(f ? cToF(c) : c);
  return {
    code,
    isDay: current.is_day === undefined ? true : Number(current.is_day) === 1,
    temp: temperature(temp),
    feels: Number.isFinite(feels) ? temperature(feels) : null,
    wind: Number.isFinite(wind) ? Math.round(f ? wind / 1.609344 : wind) : null,
    humidity: Number.isFinite(humidity) ? Math.round(humidity) : null,
    units: f ? "f" : "c",
    time: typeof current.time === "string" ? current.time : null,
  };
}

module.exports = {
  SCENES,
  CODES,
  PREVIEW_CODES,
  STYLES,
  UNITS,
  FIELDS,
  DEFAULT_SETTINGS,
  sceneFor,
  parseCity,
  cityLabel,
  parseSettings,
  withDefaults,
  toReading,
};
