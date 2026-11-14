// Donation media: the live half. One Session per channel holds the queue
// (lib/donationMediaQueue.js), the platform listeners (realtime/donationMediaConnectors.js) and the
// sockets of /ws/donation-media - the OBS players, the OBS panel docks and the moderators' panels on
// the site.
//
// Who may connect is decided in authorizeUpgrade (called by realtime/socketServer.js before the
// handshake), because two of the three kinds of client have no session: an OBS browser source and
// an OBS dock carry no login cookie, so they authenticate with the secret key in their link
// (DonationMediaSettings.playerKey / panelKey). A moderator on the site authenticates with the
// session like every other socket here, and gets control only while middleware/permissions.js's
// section check for "donationMedia" says yes - otherwise a read-only view.
//
// Everything is in this process's memory, as the Durak rooms are: one web process serves every
// channel. The queue is written to Mongo on every change (debounced), so a restart loses at most
// the last second, and the listeners are restarted at boot for every configured channel.
const donationMediaRepo = require("../db/donationMediaRepo");
const donationMediaNowPlayingRepo = require("../db/donationMediaNowPlayingRepo");
const channelsRepo = require("../db/channelsRepo");
const { computePermission, canEditSectionAt } = require("../middleware/permissions");
const { MediaQueue } = require("../lib/donationMediaQueue");
const { extractVideoId } = require("../lib/donationMedia");
const { CONNECTORS } = require("./donationMediaConnectors");

const SAVE_DEBOUNCE_MS = 1000;
const PERMISSION_RECHECK_MS = 60 * 1000;
const MAX_MESSAGE_BYTES = 4096;
// Per socket: a panel button is a click, not a stream. Generous for a human, a wall for a script.
const RATE_WINDOW_MS = 10 * 1000;
const RATE_MAX = 40;
const OEMBED_TIMEOUT_MS = 8000;
// While a clip plays, the bot's "what is playing" row (db/donationMediaNowPlayingRepo.js) is
// re-written this often even when nothing about it changed, so the bot can tell a live row from
// one left behind by a web process that died mid-clip. The bot's staleness limit is a hand-kept
// multiple of this (TwitchBot commands/nowPlaying.js, STALE_MS).
const NOW_PLAYING_REFRESH_MS = 60 * 1000;

const sessions = new Map(); // channelId -> Session

class Session {
  constructor(channelId, channelLogin) {
    this.channelId = String(channelId);
    this.channelLogin = channelLogin;
    this.players = new Set();
    this.panels = new Set(); // { ws, principal }
    this.connectors = {}; // platform -> { stop }
    this.status = {}; // platform -> { connected, error }
    this.keys = { playerKey: null, panelKey: null };
    this.saveTimer = null;
    this.published = null; // { key, at, itemId, startedAt } - the last now-playing row written
    this.publishChain = Promise.resolve();
    this.queue = new MediaQueue({
      send: (target, message) => this.send(target, message),
      onChange: () => this.scheduleSave(),
    });
    this.ready = donationMediaRepo
      .loadQueue(this.channelId)
      .then((stored) => {
        this.queue.restore(stored);
        // A clip queued moments before a restart may not have had its name looked up yet.
        for (const item of this.queue.queue) {
          if (!item.title) fetchTitle(item.videoId).then((title) => title && this.queue.setTitle(item.id, title));
        }
      })
      .catch((err) => console.error(`[donationMedia] ${channelLogin}: could not load the queue:`, err.message))
      // Nothing plays right after a load (the clip that was playing went back into the queue), and
      // a row left by the previous process may still say otherwise.
      .then(() => this.publishNowPlaying());
  }

  send(target, message) {
    // Every change of what plays, and every second of progress while it plays, is announced to the
    // panels - so this is the one place the now-playing row is kept in step, instead of a call
    // after every queue transition.
    if (target === "panels") this.publishNowPlaying();
    const data = JSON.stringify(message);
    const sockets = target === "players" ? this.players : [...this.panels].map((p) => p.ws);
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  // Writes the bot's now-playing row when what plays changed, or when the row is due a refresh.
  // Writes are chained, so a skip right after a start cannot land before it.
  publishNowPlaying() {
    const current = this.queue.current;
    const paused = Boolean(current && this.queue.paused);
    const key = current ? `${current.id}|${paused ? 1 : 0}|${current.title || ""}` : "none";
    const now = Date.now();
    const prev = this.published;
    if (prev && prev.key === key && (!current || now - prev.at < NOW_PLAYING_REFRESH_MS)) return;

    const startedAt = current && prev && prev.itemId === current.id ? prev.startedAt : new Date(now);
    this.published = { key, at: now, itemId: current ? current.id : null, startedAt };
    const item = current
      ? {
          videoId: current.videoId,
          title: current.title || null,
          donor: current.donor || null,
          amount: current.amount ? { ...current.amount } : null,
          platform: current.platform || null,
          // A clip added from the OBS dock is the streamer's own; "OBS" is not a name to put in chat.
          addedBy: current.addedBy && current.addedBy !== "OBS" ? current.addedBy : null,
        }
      : null;
    this.publishChain = this.publishChain
      .then(() => donationMediaNowPlayingRepo.setNowPlaying(this.channelId, this.channelLogin, { item, paused, startedAt }))
      // Left as is on failure: a playing row is retried by the refresh above, and a stopped one
      // that failed to land goes stale on the bot's side.
      .catch((err) => console.error(`[donationMedia] ${this.channelLogin}: could not write now-playing:`, err.message));
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      donationMediaRepo
        .saveQueue(this.channelId, this.queue.toStored())
        .catch((err) => console.error(`[donationMedia] ${this.channelLogin}: could not save the queue:`, err.message));
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  // (Re)start the listeners from a decrypted config (db/donationMediaRepo.js's toConfig). Called at
  // boot and after every save on the setup page; the queue is untouched.
  applyConfig(config) {
    this.stopConnectors();
    if (!config) {
      this.queue.setPlatforms(this.status);
      return;
    }
    this.keys = { playerKey: config.playerKey, panelKey: config.panelKey };

    for (const [platform, { configKey, connect }] of Object.entries(CONNECTORS)) {
      const platformConfig = config[configKey];
      if (!platformConfig) continue;
      this.status[platform] = { connected: false, error: null };
      try {
        this.connectors[platform] = connect(platformConfig, {
          onMedia: ({ media, dedupeKey }) => this.onMedia(platform, media, dedupeKey),
          onStatus: (status) => this.setStatus(platform, status),
        });
      } catch (err) {
        console.error(`[donationMedia] ${this.channelLogin}: ${platform} failed to start:`, err);
        this.status[platform] = { connected: false, error: err.message };
      }
    }
    this.queue.setPlatforms(this.status);

    // Sockets that came in with a key that is no longer this channel's (the owner made new links).
    for (const ws of this.players) {
      if (ws.principal.key && ws.principal.key !== this.keys.playerKey) ws.close(4001, "key replaced");
    }
    for (const { ws, principal } of this.panels) {
      if (principal.key && principal.key !== this.keys.panelKey) ws.close(4001, "key replaced");
    }
  }

  stopConnectors() {
    for (const connector of Object.values(this.connectors)) {
      try {
        connector.stop();
      } catch (err) {
        console.error(`[donationMedia] ${this.channelLogin}: stopping a listener failed:`, err.message);
      }
    }
    this.connectors = {};
    this.status = {};
  }

  setStatus(platform, { connected, error }) {
    const before = this.status[platform];
    if (!before) return; // a late event from a listener already replaced
    if (before.connected === connected && before.error === error) return;
    if (before.connected !== connected) {
      console.log(`[donationMedia] ${this.channelLogin}: ${platform} ${connected ? "connected" : "disconnected"}${error ? ` (${error})` : ""}`);
    }
    this.status[platform] = { connected, error: error || null };
    this.queue.setPlatforms(this.status);
  }

  onMedia(platform, media, dedupeKey) {
    const item = this.queue.add(platform, media, { dedupeKey });
    if (!item) return;
    console.log(`[donationMedia] ${this.channelLogin}: ${platform} queued ${item.videoId} (${this.queue.queue.length} waiting)`);
    if (!item.title) fetchTitle(item.videoId).then((title) => title && this.queue.setTitle(item.id, title));
  }
}

// The clip's name for the panel when the platform did not send one. The player reports it as well
// once the clip plays; this is what the queue shows before that.
async function fetchTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.title ? String(data.title).slice(0, 200) : null;
  } catch (_) {
    return null;
  }
}

function getSession(channelId, channelLogin) {
  const id = String(channelId);
  let session = sessions.get(id);
  if (!session) {
    session = new Session(id, channelLogin);
    sessions.set(id, session);
  }
  return session;
}

// Boot: start listening for every channel that has a platform connected.
async function start() {
  try {
    const configs = await donationMediaRepo.listConfigured();
    for (const config of configs) {
      const session = getSession(config.channelId, config.channelLogin);
      await session.ready;
      session.applyConfig(config);
    }
    if (configs.length) console.log(`[donationMedia] listening for ${configs.length} channel(s)`);
  } catch (err) {
    console.error("[donationMedia] start failed:", err);
  }
}

// After the setup page saved something for this channel.
async function reload(channelId, channelLogin) {
  const config = await donationMediaRepo.findByChannelId(channelId);
  const session = getSession(channelId, channelLogin);
  await session.ready;
  session.applyConfig(config);
}

// { DonationAlerts: { connected, error }, ... } for the setup page; {} when nothing listens.
function statusOf(channelId) {
  const session = sessions.get(String(channelId));
  return session ? JSON.parse(JSON.stringify(session.status)) : {};
}

// --- the socket ------------------------------------------------------------------------------------

// Called by realtime/socketServer.js before the handshake. Returns the principal the connection
// will carry, or null to refuse it.
//   ?key=<playerKey|panelKey>   an OBS source or dock
//   ?channel=<login>            a logged-in moderator, owner or admin on the site
async function authorizeUpgrade(req, sessionUser) {
  let query;
  try {
    query = new URL(req.url, "http://placeholder").searchParams;
  } catch (_) {
    return null;
  }

  const key = query.get("key");
  if (key) {
    const found = await donationMediaRepo.findByKey(key);
    if (!found) return null;
    return {
      role: found.role,
      key,
      channelId: String(found.channelId),
      channelLogin: found.channelLogin,
      canControl: found.role === "panel",
      by: "OBS",
    };
  }

  const login = (query.get("channel") || "").toLowerCase();
  if (!sessionUser || !sessionUser.userId || !/^[a-z0-9_]{1,25}$/.test(login)) return null;
  const channel = await channelsRepo.findByLogin(login);
  if (!channel) return null;
  const level = await computePermission(sessionUser.userId, login);
  if (level > 2) return null;
  const principal = {
    role: "panel",
    key: null,
    channelId: String(channel.channelId),
    channelLogin: channel.channelLogin,
    userId: String(sessionUser.userId),
    by: sessionUser.login || String(sessionUser.userId),
    canControl: await canEditSectionAt(level, channel.channelId, sessionUser.userId, "donationMedia"),
    checkedAt: Date.now(),
  };
  return principal;
}

// A moderator demoted, or denied the section, while their panel is open: control is re-derived at
// most once a minute, on the next command they send.
async function refreshControl(principal) {
  if (!principal.userId || Date.now() - principal.checkedAt < PERMISSION_RECHECK_MS) return principal.canControl;
  const level = await computePermission(principal.userId, principal.channelLogin);
  principal.canControl = level <= 2 && (await canEditSectionAt(level, principal.channelId, principal.userId, "donationMedia"));
  principal.checkedAt = Date.now();
  return principal.canControl;
}

function rateLimited(ws) {
  const now = Date.now();
  if (!ws.rate || now - ws.rate.start > RATE_WINDOW_MS) ws.rate = { start: now, count: 0 };
  ws.rate.count++;
  return ws.rate.count > RATE_MAX;
}

function parseMessage(data) {
  if (!data || data.length > MAX_MESSAGE_BYTES) return null;
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg.type === "string" ? msg : null;
  } catch (_) {
    return null;
  }
}

const asId = (value) => (Number.isInteger(value) && value > 0 ? value : null);

async function handlePanelCommand(session, ws, principal, msg) {
  const reply = (payload) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "reply", reqId: msg.reqId, ...payload }));
  if (!(await refreshControl(principal))) {
    ws.send(JSON.stringify({ type: "access", canControl: false }));
    return;
  }
  const q = session.queue;
  switch (msg.type) {
    case "pause":
      return q.pause();
    case "resume":
      return q.resume();
    case "skip":
      return q.skip(principal.by);
    case "seek":
      return q.seek(Number(msg.time));
    case "replay":
      return asId(msg.id) && q.replay(msg.id, { next: msg.next === true });
    case "remove":
      return asId(msg.id) && q.remove(msg.id, principal.by);
    case "moveTop":
      return asId(msg.id) && q.moveTop(msg.id);
    case "clearHistory":
      return q.clearHistory();
    case "add": {
      const videoId = extractVideoId(typeof msg.url === "string" ? msg.url.slice(0, 300) : "");
      reply({ ok: Boolean(videoId) });
      if (!videoId) return;
      const item = q.add("manual", { videoId, title: "", donor: "", amount: null, message: "", start: 0, end: 0 }, { addedBy: principal.by });
      if (item) fetchTitle(videoId).then((title) => title && q.setTitle(item.id, title));
      return;
    }
    default:
      return;
  }
}

async function handleConnection(ws, principal) {
  const session = getSession(principal.channelId, principal.channelLogin);
  ws.principal = principal;
  // Messages that arrive while the stored queue is still loading wait for it.
  const pending = [];
  let ready = false;

  const onMessage = async (data) => {
    if (rateLimited(ws)) return;
    const msg = parseMessage(data);
    if (!msg) return;
    try {
      if (principal.role === "player") {
        if (msg.type === "ended") session.queue.videoEnded({ id: msg.id, error: msg.error === true });
        else if (msg.type === "progress") {
          session.queue.reportProgress({
            id: msg.id,
            time: msg.time,
            duration: msg.duration,
            title: typeof msg.title === "string" ? msg.title.slice(0, 200) : "",
          });
        }
        return;
      }
      await handlePanelCommand(session, ws, principal, msg);
    } catch (err) {
      console.error(`[donationMedia] ${session.channelLogin}: command failed:`, err);
    }
  };

  ws.on("message", (data) => (ready ? onMessage(data) : pending.push(data)));
  ws.on("error", () => {});

  await session.ready;
  if (ws.readyState !== 1) return;

  // The key could have been replaced between the upgrade and now.
  if (principal.key && session.keys.playerKey && principal.key !== session.keys.playerKey && principal.key !== session.keys.panelKey) {
    ws.close(4001, "key replaced");
    return;
  }

  if (principal.role === "player") {
    session.players.add(ws);
    ws.on("close", () => {
      session.players.delete(ws);
      session.queue.playerLeft();
    });
    session.queue.playerJoined((message) => ws.readyState === 1 && ws.send(JSON.stringify(message)));
  } else {
    const entry = { ws, principal };
    session.panels.add(entry);
    ws.on("close", () => session.panels.delete(entry));
    ws.send(JSON.stringify({ type: "access", canControl: principal.canControl }));
    ws.send(JSON.stringify({ type: "state", state: session.queue.snapshot() }));
  }

  ready = true;
  for (const data of pending.splice(0)) onMessage(data);
}

module.exports = {
  start,
  reload,
  statusOf,
  // realtime/socketServer.js's handler contract
  authorizeUpgrade,
  handleConnection,
  // for tests
  _sessions: sessions,
};
