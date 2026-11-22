// Donation media ("медиа за донат"): the pure half of the feature - reading what each donation
// platform sends, and reading the keys a streamer pastes into the setup page. No network, no
// database: realtime/donationMedia/ does the connecting and the queue, this decides what a message
// means, so every rule here can be tested against recorded payloads.
//
// Three platforms, three protocols, one shape out:
//   { videoId, title, donor, amount: { value, currency } | null, message, start, end }
// Anything a platform sends that is not a YouTube clip is `null` - the queue only plays YouTube.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_URL_RE = /(?:youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/|[?&]v=)([A-Za-z0-9_-]{11})/;

// Donor-written text is shown on a moderator's screen and (title) in an OBS dock: bounded, single
// line for names, control characters out. It never reaches the page as HTML - the panel writes it
// through textContent - so this is about size and layout, not escaping.
const LIMITS = { donor: 64, message: 300, title: 200 };

// DonationAlerts' media event carries no currency of its own, only the paid sum converted into
// these ten (`paid_amounts`). Which one to show is the streamer's choice on the setup page.
const DA_CURRENCIES = ["RUB", "USD", "EUR", "UAH", "KZT", "BYN", "BRL", "TRY", "PLN", "UZS"];
const DEFAULT_DA_CURRENCY = "RUB";

// DonatePay's media notification carries a sum without a currency. Its widgets are served from
// these two hosts, and the setup page fetches the widget page from the pasted link - so the host
// is checked against this list rather than taken from the link (the server must not be pointed at
// an arbitrary address by a form field).
const DONATEPAY_ORIGINS = ["https://widget.donatepay.eu", "https://widget.donatepay.ru"];
const DEFAULT_DONATEPAY_CURRENCY = "RUB";

function extractVideoId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;
  const match = trimmed.match(VIDEO_URL_RE);
  return match ? match[1] : null;
}

// The platforms like to serialise JSON twice: a field may be an object or a string holding one.
function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function toSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cleanText(value, max, { singleLine = false } = {}) {
  if (value === undefined || value === null) return "";
  let text = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n");
  if (singleLine) text = text.replace(/\s+/g, " ");
  text = text.trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function makeAmount(value, currency) {
  const n = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : "";
  return { value: Math.round(n * 100) / 100, currency: code };
}

function media({ videoId, title, donor, amount, message, start, end }) {
  return {
    videoId,
    title: cleanText(title, LIMITS.title, { singleLine: true }),
    donor: cleanText(donor, LIMITS.donor, { singleLine: true }),
    amount: amount || null,
    message: cleanText(message, LIMITS.message),
    start: toSeconds(start),
    end: toSeconds(end),
  };
}

// --- DonationAlerts ------------------------------------------------------------------------------
// socket.io 2.x event "media", payload a JSON string:
//   { action: "add", media: { media_id, sub_type: "youtube", title, additional_data: "<JSON>" } }
// additional_data: { video_id, url, owner, start_from, paid_amounts: { RUB: 414.01, USD: 5, ... } }
// Returns { media, dedupeKey } or null. A test alert has media_id 0, so it carries no dedupe key.
function parseDonationAlertsMedia(raw, { currency = DEFAULT_DA_CURRENCY } = {}) {
  const data = parseMaybeJson(raw);
  if (!data || data.action !== "add" || !data.media) return null;
  const item = data.media;
  if (item.sub_type !== "youtube") return null;
  const extra = parseMaybeJson(item.additional_data) || {};

  const videoId = extractVideoId(extra.video_id) || extractVideoId(extra.url);
  if (!videoId) return null;

  const paid = extra.paid_amounts && typeof extra.paid_amounts === "object" ? extra.paid_amounts : {};
  let amount = null;
  if (paid[currency] !== undefined) amount = makeAmount(paid[currency], currency);
  else {
    const fallback = DA_CURRENCIES.find((code) => paid[code] !== undefined);
    if (fallback) amount = makeAmount(paid[fallback], fallback);
  }

  const mediaId = parseInt(item.media_id, 10);
  return {
    dedupeKey: mediaId > 0 ? `da:${mediaId}` : null,
    media: media({ videoId, title: item.title, donor: extra.owner, amount, start: extra.start_from }),
  };
}

// --- Donatello -----------------------------------------------------------------------------------
// socket.io 4.x; every event of a streamer is named after their userId. The media one:
//   { userId, interactionWidget: true, widgetState: 1, interactionWidgetId, lastDonate: {
//       id, clientName, message, amount, currency, interactionMedia: "<video id>",
//       interactionMediaName, interactionMediaStartTime } }
// The socket sends every client the events of EVERY streamer, so both ids are checked here.
function parseDonatelloEvent(message, { userId, widgetId }) {
  if (!message || message.userId !== userId) return null;
  if (!message.interactionWidget || message.widgetState !== 1 || !message.lastDonate) return null;
  if (widgetId && message.interactionWidgetId !== widgetId) return null;

  const donate = message.lastDonate;
  const videoId = extractVideoId(donate.interactionMedia);
  if (!videoId) return null;

  // The panel's test button replays one fixed stored donation (`source: "manual"`) - the same id
  // and the same months-old createdAt on every press - so keying it by id lets the first test in
  // and drops every later one as a repeat. A manual donation is therefore never deduplicated.
  const dedupeKey = donate.id && donate.source !== "manual" ? `dn:${donate.id}` : null;

  return {
    dedupeKey,
    media: media({
      videoId,
      title: donate.interactionMediaName,
      donor: donate.clientName,
      amount: makeAmount(donate.amount, donate.currency),
      message: donate.message,
      start: donate.interactionMediaStartTime,
    }),
  };
}

// --- DonatePay -----------------------------------------------------------------------------------
// Centrifugo publication in notifications#<userId>:
//   { data: { notification: { id?, type, vars: "<JSON>" } } }
// vars: { name, comment, sum, video_id, video_link, video_data: "<JSON {start, finish}>" }
function parseDonatePayNotification(message) {
  const notification = message && message.data && message.data.notification;
  if (!notification) return null;
  const vars = parseMaybeJson(notification.vars) || {};
  const videoId = extractVideoId(vars.video_id) || extractVideoId(vars.video_link);
  if (!videoId) return null;

  const videoData = parseMaybeJson(vars.video_data) || {};
  return {
    dedupeKey: notification.id ? `dp:${notification.id}` : null,
    media: media({
      videoId,
      donor: vars.name,
      amount: makeAmount(vars.sum, vars.currency || DEFAULT_DONATEPAY_CURRENCY),
      message: vars.comment,
      start: videoData.start,
      end: videoData.finish,
    }),
  };
}

// --- Keys from the setup page --------------------------------------------------------------------
// The streamer pastes whatever their platform's dashboard shows: a widget link or the bare token.
// Each reader returns { ok: true, ... } or { ok: false, error: "<locale key suffix>" }.

function asUrl(text) {
  try {
    return new URL(text);
  } catch (_) {
    return null;
  }
}

// The alert/media widget link: https://www.donationalerts.com/widget/...?token=XXXX
function parseDonationAlertsToken(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "empty" };
  const url = asUrl(text);
  const token = url ? url.searchParams.get("token") || "" : text;
  if (!/^[A-Za-z0-9]{10,64}$/.test(token)) return { ok: false, error: "daToken" };
  return { ok: true, token };
}

function parseDonationAlertsCurrency(input) {
  const code = String(input ?? "").trim().toUpperCase();
  return DA_CURRENCIES.includes(code) ? code : DEFAULT_DA_CURRENCY;
}

const DONATELLO_ORIGIN = "https://donatello.to";

// The media widget link: https://donatello.to/widget/<24 hex widget id>/token/<32 hex token>.
// The link does not carry the user id the socket needs (events are named after it); the widget's
// own page does, and only to a request with the right token. So the streamer pastes the link alone
// and the site reads the user id off that page (lib/donatelloWidgetPage.js) - the page URL is
// rebuilt from the two parsed parts, never fetched as pasted.
function parseDonatelloWidgetLink(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "empty" };
  const url = asUrl(text);
  if (!url || url.origin !== DONATELLO_ORIGIN) return { ok: false, error: "donatelloLink" };
  const match = url.pathname.match(/^\/widget\/([0-9a-f]{24})\/token\/([0-9a-f]{32})\/?$/i);
  if (!match) return { ok: false, error: "donatelloLink" };
  return { ok: true, widgetId: match[1].toLowerCase(), token: match[2].toLowerCase() };
}

function donatelloWidgetPageUrl({ widgetId, token }) {
  return `${DONATELLO_ORIGIN}/widget/${widgetId}/token/${token}`;
}

// The widget page declares, in an inline script:
//   const userId = '<24 hex>';  const currentWidgetId = '<24 hex>';
//   WidgetConfig = {..."widgetBehaviour":"1"...}   ("1" = YouTube video; 2 timer, 3 wheel, ...)
// A link to a timer or a wheel is a real widget of the same streamer, so it is refused by type
// rather than accepted and left silent forever.
function parseDonatelloWidgetPage(html, widgetId) {
  const text = String(html ?? "");
  const user = text.match(/const\s+userId\s*=\s*['"]([0-9a-f]{24})['"]/i);
  const widget = text.match(/const\s+currentWidgetId\s*=\s*['"]([0-9a-f]{24})['"]/i);
  if (!user || !widget || widget[1].toLowerCase() !== widgetId) return { ok: false, error: "donatelloLink" };
  const behaviour = text.match(/"widgetBehaviour"\s*:\s*"?(\d+)"?/);
  if (behaviour && behaviour[1] !== "1") return { ok: false, error: "donatelloNotMedia" };
  return { ok: true, userId: user[1].toLowerCase() };
}

// The media widget link: https://widget.donatepay.eu/widgets/media/<64 hex>
function parseDonatePayWidget(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "empty" };
  const url = asUrl(text);
  let origin = DONATEPAY_ORIGINS[0];
  let token = text;
  if (url) {
    if (!DONATEPAY_ORIGINS.includes(url.origin)) return { ok: false, error: "dpHost" };
    origin = url.origin;
    const match = url.pathname.match(/\/widgets\/media\/([0-9a-f]{64})\/?$/i);
    token = match ? match[1] : "";
  }
  if (!/^[0-9a-f]{64}$/i.test(token)) return { ok: false, error: "dpToken" };
  return { ok: true, token: token.toLowerCase(), origin };
}

// Shown on the setup page in place of a stored secret: enough to recognise which key is saved,
// not enough to use it.
function maskSecret(secret) {
  const text = String(secret ?? "");
  if (text.length <= 6) return "•".repeat(text.length);
  return "•".repeat(6) + text.slice(-4);
}

module.exports = {
  LIMITS,
  DA_CURRENCIES,
  DEFAULT_DA_CURRENCY,
  DONATEPAY_ORIGINS,
  extractVideoId,
  parseMaybeJson,
  toSeconds,
  cleanText,
  makeAmount,
  parseDonationAlertsMedia,
  parseDonatelloEvent,
  parseDonatePayNotification,
  parseDonationAlertsToken,
  parseDonationAlertsCurrency,
  parseDonatelloWidgetLink,
  donatelloWidgetPageUrl,
  parseDonatelloWidgetPage,
  parseDonatePayWidget,
  maskSecret,
};
