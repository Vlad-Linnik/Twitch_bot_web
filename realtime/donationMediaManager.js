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
const donationMediaChatCommandsRepo = require("../db/donationMediaChatCommandsRepo");
const chatCommand = require("../lib/donationMediaChatCommand");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const { computePermission, canEditSectionAt } = require("../middleware/permissions");
const { MediaQueue } = require("../lib/donationMediaQueue");
const { extractVideoId } = require("../lib/donationMedia");
const { CONNECTORS } = require("./donationMediaConnectors");
const radioSources = require("../lib/radioSources");
const { MusicRadio } = require("../lib/musicRadio");
const musicGraphRepo = require("../db/musicGraphRepo");
const icons = require("../lib/donationMediaIcons");

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
// How often DonationMediaChatCommands is looked at for a moderator's `!clip ...` from chat. The
// bot waits for the outcome to say it in chat (TwitchBot commands/donationMediaControl.js,
// RESULT_WAIT_MS - a hand-kept multiple of this), so this is most of the delay a moderator sees.
const CHAT_COMMAND_POLL_MS = 1000;
// At most this many commands per tick: a burst is drained over a few ticks rather than in one loop.
const CHAT_COMMAND_BATCH = 20;
// A radio top-up that found nothing new is not retried before this: the Mix of the same track
// would answer the same, and a source that is down should not be asked every second.
const RADIO_RETRY_MS = 2 * 60 * 1000;

const sessions = new Map(); // channelId -> Session
// The site admin's Easter eggs, for every channel: videoId -> { slot: [icon] }. Loaded at boot and
// after every edit (reloadEggs).
let eggs = new Map();

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
    this.radioRetryAt = 0;
    this.radioStarting = false; // startRadio's own first fetch is running; no top-up beside it
    this.buttons = icons.normalizeButtons(null);
    this.queue = new MediaQueue({
      // The panel's icons follow the clip: an Easter egg is for one video.
      decorate: (snap) => ({ ...snap, icons: icons.resolveIcons(this.buttons, snap.current ? eggs.get(snap.current.videoId) : null) }),
      send: (target, message) => this.send(target, message),
      onChange: () => {
        this.scheduleSave();
        this.topUpRadio();
      },
      onFinished: (item, how) => this.onFinished(item, how),
    });
    this.music = new MusicRadio({ channelId: this.channelId, sources: radioSources, repo: musicGraphRepo });
    this.ready = Promise.resolve()
      // A failure here costs the theme, not the queue.
      .then(() => this.loadPanelSettings().catch((err) => console.error(`[donationMedia] ${channelLogin}: could not load panel settings:`, err.message)))
      .then(() => donationMediaRepo.loadQueue(this.channelId))
      .then((stored) => {
        this.queue.restore(stored);
        // A clip queued moments before a restart may not have had its name looked up yet.
        for (const item of this.queue.queue) {
          if (!item.title) fetchTitle(item.videoId).then((title) => title && this.queue.setTitle(item.id, title));
        }
        for (const entry of this.queue.playlist) {
          if (!entry.title) fetchTitle(entry.videoId).then((title) => title && this.queue.setPlaylistTitle(entry.id, title));
        }
      })
      .catch((err) => console.error(`[donationMedia] ${channelLogin}: could not load the queue:`, err.message))
      // Nothing plays right after a load (the clip that was playing went back into the queue), and
      // a row left by the previous process may still say otherwise.
      .then(() => this.publishNowPlaying())
      .then(() => this.music.load())
      // A radio saved as on with a nearly empty feed carries on after a restart.
      .then(() => this.topUpRadio());
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
    const author = current ? channelNameFor(current.videoId, () => this.publishNowPlaying()) : null;
    const key = current ? `${current.id}|${paused ? 1 : 0}|${current.title || ""}|${author || ""}` : "none";
    const now = Date.now();
    const prev = this.published;
    if (prev && prev.key === key && (!current || now - prev.at < NOW_PLAYING_REFRESH_MS)) return;

    const startedAt = current && prev && prev.itemId === current.id ? prev.startedAt : new Date(now);
    this.published = { key, at: now, itemId: current ? current.id : null, startedAt };
    const item = current
      ? {
          // The bot sends it back with a `!clip` command, so the command applies only to this clip
          // (lib/donationMediaChatCommand.js).
          id: current.id,
          videoId: current.videoId,
          title: current.title || null,
          // The YouTube channel the clip is from - none of the platforms send it, so it is looked
          // up here and arrives a moment after the clip starts (the row is re-written then).
          author: author || null,
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

  // The owner's panel settings: the button theme and the history length.
  async loadPanelSettings() {
    const config = await donationMediaRepo.findByChannelId(this.channelId);
    if (!config) return;
    this.buttons = config.buttons;
    this.queue.setHistoryLimit(config.historyLimit);
  }

  // --- the "up next" feed (lib/radioSources.js does the asking) ----------------------------------

  // Runs one fetch of a kind at a time; the panel shows the kind as busy meanwhile. Resolves to the
  // tracks, or null when one of this kind was already running or it failed.
  async fetchInto(kind, load, { repeats = false } = {}) {
    if (this.queue.radioBusy[kind]) return null;
    this.queue.setRadioBusy(kind, true);
    try {
      return await load(this.queue.feedExclusions({ repeats }));
    } catch (err) {
      console.error(`[donationMedia] ${this.channelLogin}: ${kind} fetch failed:`, err.message);
      return null;
    } finally {
      this.queue.setRadioBusy(kind, false);
    }
  }

  // Called after every change: while the radio (or endless music) is on and the feed runs low, the
  // music graph tops it up. When it has nothing (YouTube would not open its root), plain Mixes are
  // tried - see MediaQueue.topUpSeeds - and then tracks played long enough ago (REPEAT_AFTER_MS) are
  // let in again: an empty feed would hand its turn to the own playlist, and the same Mix asked again
  // would answer the same until it is restarted.
  topUpRadio() {
    const seeds = this.queue.topUpSeeds();
    if (seeds.length === 0 || this.radioStarting || this.queue.radioBusy.radio || Date.now() < this.radioRetryAt) return;
    const radio = this.queue.radio;
    this.topUpFrom(radio, [...seeds.map((s) => ({ seed: s, repeats: false })), ...seeds.map((s) => ({ seed: s, repeats: true }))]);
  }

  async topUpFrom(radio, attempts) {
    const chosen = await this.fetchInto("radio", (ex) => this.music.next(this.queue, ex), { repeats: true });
    if (this.queue.radio !== radio) return;
    if (chosen && this.queue.addUpNext(chosen, "radio", { repeats: true }) > 0) return;
    for (const { seed, repeats } of attempts) {
      const tracks = await this.fetchInto("radio", (ex) => radioSources.radioFor(seed, ex), { repeats });
      if (tracks) this.music.learn(seed, tracks);
      // The radio may have been switched off or restarted from another track meanwhile (and its
      // first fetch may be what is running now).
      if (this.queue.radio !== radio || !tracks) return;
      if (this.queue.addUpNext(tracks, "radio", { repeats }) > 0) return;
    }
    this.radioRetryAt = Date.now() + RADIO_RETRY_MS;
  }

  // A queue item ended; the next one has not been chosen yet. After a skip the radio's part of the
  // feed is chosen anew at once, or the branch just skipped would go on from it.
  onFinished(item, how) {
    const q = this.queue;
    const known = authorCache.get(item.videoId);
    const outcome = this.music.finished(item, how, (known && known.author) || "");
    if (!outcome || outcome === "heard" || !(q.radio || q.infinite)) return;
    const tail = q.upNext.filter((u) => q.isRadioTail(u)).length;
    if (tail > 0 && (outcome === "skipEarly" || outcome === "skipMid")) {
      q.replaceRadioTail(this.music.nextNow(q, { ...q.feedExclusions({ repeats: true, tail: false }), limit: tail }));
    }
    this.music.grow(q);
  }

  // The track a panel pointed at, with a name for the seed: from wherever the panel saw it, else
  // oEmbed.
  async trackInfo(videoId) {
    const q = this.queue;
    const known = [q.current, ...q.queue, ...q.history, ...q.playlist, ...q.upNext].find((i) => i && i.videoId === videoId && i.title);
    const info = known && known.author ? null : await radioSources.embedInfo(videoId);
    return {
      videoId,
      title: (known && known.title) || (info && info.title) || "",
      author: (known && known.author) || (info && info.author) || "",
    };
  }

  async startRadio(videoId) {
    const seed = await this.trackInfo(videoId);
    this.radioStarting = true;
    try {
      this.queue.startRadio(seed);
      const radio = this.queue.radio;
      this.radioRetryAt = 0;
      this.music.restart();
      this.music.noted(seed, "liked");
      // fetchInto refuses while a top-up of the previous radio is still running; that one's answer
      // is dropped (the radio object changed), and this waits it out.
      for (let i = 0; i < 30 && this.queue.radioBusy.radio; i++) await new Promise((r) => setTimeout(r, 500));
      const chosen = await this.fetchInto("radio", (ex) => this.music.next(this.queue, ex), { repeats: true });
      if (this.queue.radio !== radio) return 0;
      const tracks = chosen && chosen.length > 0 ? chosen : await this.fetchInto("radio", (ex) => radioSources.radioFor(seed, ex));
      if (this.queue.radio !== radio) return 0;
      if (tracks && tracks !== chosen) this.music.learn(seed, tracks);
      // Radio from the track that is playing lets it finish; from any other, the radio starts now.
      const playing = this.queue.current && this.queue.current.videoId === videoId;
      const added = tracks ? this.queue.addUpNext(tracks, "radio", { repeats: tracks === chosen, ...(playing ? { first: true } : { playNow: true }) }) : 0;
      if (added === 0) this.queue.stopRadio();
      return added;
    } finally {
      this.radioStarting = false;
    }
  }

  async moreFromArtist(videoId) {
    const seed = await this.trackInfo(videoId);
    // From the graph when it knows enough of them. Such tracks may have played before - the graph
    // keeps its own count of when - hence `repeats`.
    const known = await this.fetchInto("artist", (ex) => this.music.byArtist(seed, this.queue, ex), { repeats: true });
    if (known && known.length > 0) return this.queue.addUpNext(known, "artist", { repeats: true });
    const tracks = await this.fetchInto("artist", (ex) => radioSources.moreFromArtist(seed, ex));
    if (tracks) this.music.learn(seed, tracks);
    return tracks ? this.queue.addUpNext(tracks, "artist") : 0;
  }

  // { added, error } - error "noKey" | "failed" | "busy" | null.
  async aiWish(text) {
    const q = this.queue;
    if (q.radioBusy.ai) return { added: 0, error: "busy" };
    let error = null;
    const tracks = await this.fetchInto("ai", async (ex) => {
      const result = await radioSources.aiPick(text, {
        ...ex,
        nowPlaying: q.current ? q.current.title : "",
        tasteTitles: q.playlist.map((p) => p.title).filter(Boolean).slice(-15),
        avoidTitles: q.upNext.map((u) => u.title).filter(Boolean),
      });
      error = result.error;
      return result.tracks;
    });
    if (tracks) this.music.learnWish(tracks);
    return { added: tracks ? q.addUpNext(tracks, "ai", { playNow: true }) : 0, error };
  }

  onMedia(platform, media, dedupeKey) {
    const item = this.queue.add(platform, media, { dedupeKey });
    if (!item) return;
    console.log(`[donationMedia] ${this.channelLogin}: ${platform} queued ${item.videoId} (${this.queue.queue.length} waiting)`);
    if (!item.title) fetchTitle(item.videoId).then((title) => title && this.queue.setTitle(item.id, title));
  }
}

// YouTube oEmbed: the clip's name and its channel's name, or null.
async function fetchVideoInfo(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    return {
      title: data.title ? String(data.title).slice(0, 200) : null,
      author: data.author_name ? String(data.author_name).slice(0, 100) : null,
    };
  } catch (_) {
    return null;
  }
}

// The clip's name for the panel when the platform did not send one. The player reports it as well
// once the clip plays; this is what the queue shows before that.
async function fetchTitle(videoId) {
  const info = await fetchVideoInfo(videoId);
  return info ? info.title : null;
}

// The YouTube channel of a clip, for the bot's now-playing row. Asked for on every publish (that is
// every second of progress), so it answers from memory and starts at most one lookup per video;
// `onLearnt` runs once the name arrives so the row picks it up without waiting for the refresh. A
// failed lookup is remembered too and retried only after AUTHOR_RETRY_MS, or a dead oEmbed would be
// asked once a second for the whole clip.
const AUTHOR_CACHE_MAX = 500;
const AUTHOR_RETRY_MS = 5 * 60 * 1000;
const authorCache = new Map(); // videoId -> { author: string | null, at, pending }

function channelNameFor(videoId, onLearnt) {
  const hit = authorCache.get(videoId);
  if (hit && (hit.pending || hit.author || Date.now() - hit.at < AUTHOR_RETRY_MS)) return hit.author;
  if (authorCache.size >= AUTHOR_CACHE_MAX) authorCache.delete(authorCache.keys().next().value);
  authorCache.set(videoId, { author: null, at: Date.now(), pending: true });
  fetchVideoInfo(videoId).then((info) => {
    const author = info && info.author ? info.author : null;
    authorCache.set(videoId, { author, at: Date.now(), pending: false });
    if (author) onLearnt();
  });
  return null;
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

// --- chat commands -------------------------------------------------------------------------------

// One `!sr <link>` from chat. Returns { status, result? }.
async function runSongRequest(cmd) {
  const config = await donationMediaRepo.findByChannelId(cmd.channelId);
  if (!config) return { status: "invalid" };
  const settings = await channelConfigRepo.getConfig(config.channelLogin);
  const sr = settings.commands && settings.commands.sr;
  if (!sr || !sr.enabled) return { status: "disabled" };

  const userId = cmd.by && cmd.by.userId ? String(cmd.by.userId) : null;
  if (!userId) return { status: "forbidden" };
  const login = cmd.by.login ? String(cmd.by.login).slice(0, 25) : userId;
  // The bot filtered by badge; the site decides with its own rules. A moderator counts only with
  // the donation media section - the same as for the panel.
  const level = await computePermission(userId, config.channelLogin);
  const isMod = level <= 2 && (await canEditSectionAt(level, config.channelId, userId, "donationMedia"));
  if (sr.access !== "all" && !isMod) return { status: "forbidden" };

  const videoId = extractVideoId(typeof cmd.videoId === "string" ? cmd.videoId.slice(0, 300) : "");
  if (!videoId) return { status: "invalid" };

  const session = getSession(config.channelId, config.channelLogin);
  await session.ready;
  const q = session.queue;
  if (!isMod && chatCommand.waitingRequestsOf(q, login) >= chatCommand.SR_PER_USER) return { status: "limit" };
  // oEmbed refuses a video whose owner forbade embedding - the OBS player could not show it.
  const info = await radioSources.embedInfo(videoId);
  if (!info) return { status: "noEmbed" };
  const item = q.add("manual", { videoId, title: info.title || "", donor: "", amount: null, message: "", start: 0, end: 0 }, { addedBy: login, viaChat: true });
  if (!item) return { status: "full" };
  const position = q.current && q.current.id === item.id ? 0 : q.queue.findIndex((i) => i.id === item.id) + 1;
  return { status: "done", result: { title: (info.title || "").slice(0, 200), position } };
}

// One `!clip ...` or `!sr ...` from chat, already claimed. Returns { status, result? }.
async function runChatCommand(cmd) {
  if (!cmd.createdAt || Date.now() - new Date(cmd.createdAt).getTime() > donationMediaChatCommandsRepo.MAX_AGE_MS) return { status: "expired" };
  if (chatCommand.isSongRequest(cmd.action)) return runSongRequest(cmd);
  return { status: await runClipCommand(cmd) };
}

async function runClipCommand(cmd) {
  if (!chatCommand.isAction(cmd.action)) return "invalid";
  // Only a channel whose session exists has anything playing: the bot found a playing row, which
  // only a session writes, so a missing one means this process restarted since.
  const session = sessions.get(String(cmd.channelId));
  if (!session) return "changed";
  await session.ready;

  // The bot checked the badge; the site's own rules decide, the same as for the queue panel - a
  // moderator the owner denied the donation media section is refused here too.
  const userId = cmd.by && cmd.by.userId ? String(cmd.by.userId) : null;
  if (!userId) return "forbidden";
  const level = await computePermission(userId, session.channelLogin);
  if (level > 2 || !(await canEditSectionAt(level, session.channelId, userId, "donationMedia"))) return "forbidden";

  const by = cmd.by.login ? String(cmd.by.login).slice(0, 25) : userId;
  return chatCommand.apply(session.queue, { action: cmd.action, itemId: cmd.itemId, by }).status;
}

let chatCommandTimer = null;
let chatCommandBusy = false;

async function pollChatCommands() {
  if (chatCommandBusy) return;
  chatCommandBusy = true;
  try {
    for (let i = 0; i < CHAT_COMMAND_BATCH; i++) {
      const cmd = await donationMediaChatCommandsRepo.claim();
      if (!cmd) break;
      let outcome;
      try {
        outcome = await runChatCommand(cmd);
      } catch (err) {
        console.error(`[donationMedia] chat command ${cmd.action} failed:`, err.message);
        outcome = { status: "invalid" };
      }
      await donationMediaChatCommandsRepo.finish(cmd._id, outcome.status, outcome.result || null);
    }
  } catch (err) {
    console.error("[donationMedia] chat command poll failed:", err.message);
  } finally {
    chatCommandBusy = false;
  }
}

function startChatCommands() {
  if (chatCommandTimer) return;
  chatCommandTimer = setInterval(pollChatCommands, CHAT_COMMAND_POLL_MS);
  chatCommandTimer.unref();
}

// Boot: start listening for every channel that has a platform connected.
async function start() {
  startChatCommands();
  await reloadEggs();
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

// The owner changed the placeholder picture: OBS players open now switch to it without a reload
// (a player opened later gets it in its page).
function setPlaceholder(channelId, url) {
  const session = sessions.get(String(channelId));
  if (session) session.send("players", { type: "placeholder", url: url || null });
}

// After the setup page changed the panel's buttons or history length: open panels redraw at once.
async function reloadPanelSettings(channelId, channelLogin) {
  const session = getSession(channelId, channelLogin);
  await session.ready;
  await session.loadPanelSettings();
  session.queue.broadcastState();
}

// After the admin edited the Easter eggs: every open panel picks them up.
async function reloadEggs() {
  try {
    const list = await donationMediaRepo.listEggs();
    eggs = new Map(list.map((e) => [e.videoId, e.icons]));
  } catch (err) {
    console.error("[donationMedia] could not load the Easter eggs:", err.message);
    return;
  }
  for (const session of sessions.values()) session.queue.broadcastState();
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

// The channel's radio and its queue, for the admin's view of the music graph; null when no session of
// the channel is running.
function musicOf(channelId) {
  const session = sessions.get(String(channelId));
  return session ? { music: session.music, queue: session.queue } : null;
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
    case "move":
      if (!asId(msg.id)) return;
      if (msg.beforeId !== null && !asId(msg.beforeId)) return;
      return q.move(msg.id, { beforeId: msg.beforeId, index: Number.isInteger(msg.index) ? msg.index : null });
    case "clearHistory":
      return q.clearHistory();
    case "cover":
      return q.setCover(typeof msg.mode === "string" ? msg.mode : null);
    case "blurStrength":
      return q.setBlurStrength(Number(msg.value));
    case "volume":
      return q.setVolume(Number(msg.value));
    case "autoPlaylist":
      return q.setAutoPlaylist(msg.on === true);
    case "playlistRemove":
      return asId(msg.id) && q.removeFromPlaylist(msg.id);
    case "playlistAdd": {
      const videoId = extractVideoId(typeof msg.url === "string" ? msg.url.slice(0, 300) : "");
      if (!videoId) return reply({ ok: false, reason: "bad" });
      if (q.playlist.some((p) => p.videoId === videoId)) return reply({ ok: false, reason: "duplicate" });
      const entry = q.addToPlaylist(videoId);
      reply(entry ? { ok: true } : { ok: false, reason: "full" });
      if (entry) {
        session.trackInfo(videoId).then((track) => {
          if (track.title) q.setPlaylistTitle(entry.id, track.title);
          session.music.noted(track, "liked");
        }).catch(() => {});
      }
      return;
    }
    case "radioStart": {
      const videoId = extractVideoId(typeof msg.url === "string" ? msg.url.slice(0, 300) : "");
      if (!videoId) return reply({ ok: false, reason: "bad" });
      const added = await session.startRadio(videoId);
      return reply(added > 0 ? { ok: true, added } : { ok: false, reason: "nothing" });
    }
    case "radioStop":
      return q.stopRadio();
    case "infinite":
      return q.setInfinite(msg.on === true);
    case "hideMusic":
      return q.setHideMusic(msg.on === true);
    case "moreFromArtist": {
      const videoId = extractVideoId(typeof msg.url === "string" ? msg.url.slice(0, 300) : "");
      if (!videoId) return reply({ ok: false, reason: "bad" });
      if (q.radioBusy.artist) return reply({ ok: false, reason: "busy" });
      const added = await session.moreFromArtist(videoId);
      return reply(added > 0 ? { ok: true, added } : { ok: false, reason: "nothing" });
    }
    case "aiWish": {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, radioSources.WISH_MAX) : "";
      if (!text) return reply({ ok: false, reason: "empty" });
      const { added, error } = await session.aiWish(text);
      return reply(added > 0 ? { ok: true, added } : { ok: false, reason: error || "nothing" });
    }
    case "upNextRemove":
      if (asId(msg.id)) {
        const entry = q.removeUpNext(msg.id);
        if (entry) session.music.noted(entry, "dropped");
      }
      return;
    case "upNextPlay":
      if (asId(msg.id)) {
        const entry = q.playUpNextNow(msg.id);
        if (entry) session.music.noted(entry, "liked");
      }
      return;
    case "upNextClear":
      return q.clearUpNext();
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
  reloadPanelSettings,
  reloadEggs,
  setPlaceholder,
  statusOf,
  musicOf,
  // realtime/socketServer.js's handler contract
  authorizeUpgrade,
  handleConnection,
  // for tests
  _sessions: sessions,
  _runChatCommand: runChatCommand,
};
