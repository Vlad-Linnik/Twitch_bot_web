// The listeners: one live connection per channel and platform, speaking each platform's own widget
// protocol - the same way the platform's own media widget in OBS does, which is why no OAuth app
// and no API key of ours is involved. The platform sends; we never call anything that acts.
//
// Each factory takes the channel's decrypted config and two callbacks:
//   onMedia({ media, dedupeKey })   a YouTube clip arrived (lib/donationMedia.js's shape)
//   onStatus({ connected, error })  connection state, for the setup page and the panels
// and returns { stop() }. What a message MEANS is decided in lib/donationMedia.js, not here.
//
// `forceNew` on both socket.io clients is load-bearing: socket.io caches one connection per URL
// and hands it to every later caller, so without it the second channel to connect would silently
// share - and authenticate over - the first channel's socket.
const ioClient = require("socket.io-client");
const ioClientV2 = require("socket.io-client-v2"); // socket.io 2.x protocol, DonationAlerts
const CentrifugeV2 = require("centrifuge-v2"); // old Centrifugo protocol, DonatePay
const WebSocket = require("ws");
const {
  parseDonationAlertsMedia,
  parseDonatelloEvent,
  parseDonatePayNotification,
} = require("../lib/donationMedia");

const DONATION_ALERTS_URL = "wss://socket1.donationalerts.com:443";
const DONATELLO_URL = "wss://donatello.to/";
const DONATEPAY_RETRY_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

function safe(fn, label) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`[donationMedia] ${label} handler failed:`, err);
    }
  };
}

// --- DonationAlerts ------------------------------------------------------------------------------
// Authorised the way the alert widget is: "add-user" with the widget token, on every (re)connect.
// A wrong token is not refused - the socket simply never receives anything - so "connected" here
// means the socket is up, not that the token is right.
function connectDonationAlerts({ token, currency }, { onMedia, onStatus }) {
  const socket = ioClientV2(DONATION_ALERTS_URL, {
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 40000,
    timeout: 30000,
  });
  const auth = () => socket.emit("add-user", { token });

  socket.on("connect", () => {
    auth();
    onStatus({ connected: true, error: null });
  });
  socket.on("disconnect", () => onStatus({ connected: false, error: null }));
  socket.on("connect_error", (err) => onStatus({ connected: false, error: String(err && err.message || err) }));
  socket.on(
    "media",
    safe((raw) => {
      const parsed = parseDonationAlertsMedia(raw, { currency: currency || undefined });
      if (parsed) onMedia(parsed);
    }, "DonationAlerts")
  );

  return {
    stop() {
      socket.removeAllListeners();
      socket.close();
    },
  };
}

// --- Donatello -----------------------------------------------------------------------------------
// The socket sends every client the events of every streamer on the platform; only the event named
// after our user id is listened to, and the parser checks the ids again.
function connectDonatello({ userId, widgetId }, { onMedia, onStatus }) {
  const socket = ioClient(DONATELLO_URL, {
    forceNew: true,
    path: "/socket.io",
    transports: ["websocket"],
    query: { userId },
  });

  socket.on("connect", () => onStatus({ connected: true, error: null }));
  socket.on("disconnect", () => onStatus({ connected: false, error: null }));
  socket.on("connect_error", (err) => onStatus({ connected: false, error: String(err && err.message || err) }));
  socket.on(
    userId,
    safe((message) => {
      const parsed = parseDonatelloEvent(message, { userId, widgetId });
      if (parsed) onMedia(parsed);
    }, "Donatello")
  );

  return {
    stop() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}

// --- DonatePay -----------------------------------------------------------------------------------
// The Centrifugo token is obtained the way the media widget obtains it: open the widget page (a
// CSRF token and session cookies), then POST /socket/token. It is short-lived, so the same dance
// runs again on every refresh. `origin` comes from lib/donationMedia.js's allowlist, never from a
// form field directly.
async function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function setCookieHeader(response) {
  const list = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return list.map((c) => c.split(";")[0]).join("; ");
}

async function donatePaySession({ token, origin }) {
  const widgetUrl = `${origin}/widgets/media/${token}`;
  const page = await fetchWithTimeout(widgetUrl);
  if (!page.ok) throw new Error(`widget page answered ${page.status}`);
  const html = await page.text();

  const csrf = (html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) || [])[1];
  const userId = (html.match(/userId:\s*'(\d+)'/) || [])[1];
  const socketHost = (html.match(/socketHost:\s*'([^']+)'/) || [])[1];
  if (!csrf || !userId || !socketHost) throw new Error("widget page not recognised");
  if (!/^wss?:\/\//.test(socketHost)) throw new Error("unexpected socket host");

  const res = await fetchWithTimeout(`${origin}/socket/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrf,
      Cookie: setCookieHeader(page),
      Referer: widgetUrl,
    },
    body: JSON.stringify({ _token: csrf, token }),
  });
  if (!res.ok) throw new Error(`/socket/token answered ${res.status}`);
  const body = await res.json();
  if (!body || !body.token) throw new Error("/socket/token returned no token");
  return { token: body.token, userId, socketHost };
}

function connectDonatePay(config, { onMedia, onStatus }) {
  let stopped = false;
  let retryTimer = null;
  let centrifuge = null;

  async function start() {
    retryTimer = null;
    if (stopped) return;
    let session;
    try {
      session = await donatePaySession(config);
    } catch (err) {
      if (stopped) return;
      onStatus({ connected: false, error: err.message });
      retryTimer = setTimeout(start, DONATEPAY_RETRY_MS);
      retryTimer.unref();
      return;
    }
    if (stopped) return;

    centrifuge = new CentrifugeV2(session.socketHost, {
      websocket: WebSocket,
      onRefresh: (ctx, cb) => {
        donatePaySession(config)
          .then((s) => cb({ status: 200, data: { token: s.token } }))
          .catch((err) => {
            onStatus({ connected: false, error: err.message });
            cb({ status: 500 });
          });
      },
    });
    centrifuge.setToken(session.token);
    centrifuge.on("connect", () => onStatus({ connected: true, error: null }));
    centrifuge.on("disconnect", (ctx) => {
      if (!stopped) onStatus({ connected: false, error: ctx && ctx.reason ? String(ctx.reason) : null });
    });
    centrifuge.subscribe(
      `notifications#${session.userId}`,
      safe((message) => {
        const parsed = parseDonatePayNotification(message);
        if (parsed) onMedia(parsed);
      }, "DonatePay")
    );
    centrifuge.connect();
  }

  start();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (centrifuge) {
        centrifuge.removeAllListeners();
        centrifuge.disconnect();
      }
    },
  };
}

// Display names double as the platform keys of the queue items and the status map.
const CONNECTORS = {
  DonationAlerts: { configKey: "donationAlerts", connect: connectDonationAlerts },
  Donatello: { configKey: "donatello", connect: connectDonatello },
  DonatePay: { configKey: "donatePay", connect: connectDonatePay },
};

module.exports = { CONNECTORS };
