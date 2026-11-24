// One channel's donation media queue: what is playing, what waits, what has been played. A state
// machine with no sockets in it - realtime/donationMediaManager.js owns the connections and hands
// this object two callbacks:
//
//   send(target, message)  target "players" (every OBS player of the channel) or "panels" (every
//                          control panel: OBS docks and moderators on the site)
//   onChange()             the state worth keeping changed (persisted, debounced, by the manager)
//
// The rules are the ones the standalone aggregator had, kept on purpose - a streamer used to it
// should not notice the move:
//   - nothing starts while no player is connected; donations wait in the queue;
//   - the last player leaving puts the unfinished clip back at the head of the queue;
//   - a player reloaded mid-clip gets the current clip again;
//   - "ended" from a stale player (an id other than the current clip's) is ignored.
//
// The channel's own playlist fills the silence between donations: with `autoPlaylist` on and the
// queue empty, a shuffled track from `playlist` plays. Anything queued (a donation, a clip a
// moderator added) cuts the track off at once; the track is remembered with its position and
// resumed from there once the queue is empty again. Playlist tracks never enter the history - it
// is the record of donations and holds only fifty, which a long evening of background music would
// push out.
//
// Past the playlist there is the "up next" feed (`upNext`): tracks the panel asked for - a radio
// from one track, more of one artist, a wish in words to the AI (lib/donationMediaRadio.js says
// where each comes from). The feed plays before the playlist, because somebody asked for it just
// now; it behaves like a playlist track in every other way (a donation cuts it off, it resumes
// afterwards, it never enters the history). The fetching is the manager's - this object only says
// when the radio wants more (radioWantsMore) and takes what arrives (addUpNext).
//
// What the radio and endless music choose comes from the music graph (lib/musicRadio.js): the queue
// tells it how each track ended (`onFinished`), and takes a new tail of the feed when a skip has
// changed what should follow (replaceRadioTail).
//
// "Endless music" (`infinite`) keeps the feed from running dry without anyone pressing "radio":
// it is topped up from the feed tracks played last. An own playlist track is what it starts from
// when no feed track has played yet, and never again: a playlist of one track would pull every
// top-up back to the same place. The playlist itself plays only while the feed is empty - but its
// songs may come up in the feed, once there are enough of them to be a taste rather than a loop:
// more than ENDLESS_PLAYLIST_OVER, counting those of at most ENDLESS_PLAYLIST_MAX_SECONDS, which are
// also the only ones that may (endlessPlaylist). A radio keeps to what it was asked for.
//
// Background music does not repeat what played within REPEAT_AFTER_MS, whatever it played as -
// a donation, a feed track or a playlist one - nor another upload of the same song (titleKey). It
// never refuses a person: a donation, a chat request, a clip added by hand and "play now" always
// play. When the playlist has nothing older and there is no feed to play instead, its track played
// longest ago does, because a short playlist would otherwise go silent for most of the stream.
// REPEAT_AFTER_MS is also when a radio that has run out of new tracks may take an old one again -
// the alternative is the own playlist cutting into it.
//
// `cover` is what the OBS player shows over the current clip: null (the clip as is), "hide",
// "blur" or "image" (a placeholder). The sound goes on in every mode - it is for a clip whose
// picture is not fit for the stream. It belongs to one clip and is reset when the next one starts -
// but it travels with that clip when the clip goes back into the queue (the OBS source reloaded,
// a restart), because the clip then starts over, and a hidden clip must not come back uncovered.
//
// `hideMusic` is a channel setting: a clip that is not a donation (isDonation) starts with "hide"
// over it, so the stream hears the background music without a video in the scene. It is only the
// default - a cover a moderator picks for one clip (`coverPick`) stands above it until that clip
// is over.

const { titleKey, REPEAT_AFTER_MS } = require("./donationMediaRadio");

const HISTORY_LIMIT = 50;
// A paid donation is never dropped for being one too many, but a runaway source (a test button
// held down, a platform replaying its backlog) must not grow one channel's state without bound -
// it is persisted whole on every change.
const QUEUE_LIMIT = 500;
const PLAYLIST_LIMIT = 300;
const ENDLESS_PLAYLIST_OVER = 10;
const ENDLESS_PLAYLIST_MAX_SECONDS = 10 * 60;
const UP_NEXT_LIMIT = 100;
// Recently played videos, never offered again by the feed while they are remembered.
const RECENT_LIMIT = 300;
// While the radio is on, the feed is topped up from the Mix once fewer than this many radio tracks
// are left in it.
const RADIO_LOW_WATER = 3;
// Radio tracks that failed to play in a row before the radio switches itself off: a Mix full of
// tracks the player cannot show must not cycle through errors forever.
const RADIO_MAX_FAILURES = 5;
// A runaway of skips must not grow the saved log without bound.
const PLAYED_LIMIT = 500;
const UP_NEXT_VIA = ["radio", "artist", "ai"];
const COVER_MODES = ["hide", "blur", "image"];
// How strong "blur" is, in percent. A channel setting rather than a per-clip one: it is chosen once
// to suit the OBS scene, then just used. The player turns the percentage into pixels.
const BLUR_DEFAULT = 60;
const BLUR_MIN = 10;
const BLUR_MAX = 100;
// The OBS player's volume, in percent of YouTube's own scale. A channel setting like the blur: it
// is set to sit right against the stream's other sound and kept for every clip and playlist track.
const VOLUME_DEFAULT = 100;
// How often a playing clip's position is saved: the most of it a server restart makes the stream
// see twice. The player reports every second; a save a second would be a Mongo write per second
// per channel for the whole stream.
const PROGRESS_SAVE_MS = 5000;

function clampBlur(value) {
  return Math.min(BLUR_MAX, Math.max(BLUR_MIN, Math.round(Number(value))));
}

function clampVolume(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value))));
}

// Paid for by a viewer, as opposed to the channel's own music: the playlist and the feed, a clip a
// moderator added by hand and a song request from chat. A donation replayed from the history is
// still one - it keeps its platform.
function isDonation(item) {
  return Boolean(item) && !item.fromPlaylist && item.platform !== "manual";
}

function cloneItem(item) {
  return item ? { ...item, amount: item.amount ? { ...item.amount } : null } : null;
}

// Moves an item of a list as MediaQueue.move says. Returns the item when its place changed.
function moveIn(list, id, { beforeId = null, index = null } = {}) {
  const from = list.findIndex((q) => q.id === id);
  if (from === -1 || beforeId === id) return null;
  const [item] = list.splice(from, 1);
  let to;
  if (beforeId === null && index === null) to = list.length;
  else if (beforeId !== null && list.some((q) => q.id === beforeId)) to = list.findIndex((q) => q.id === beforeId);
  else if (Number.isInteger(index)) to = Math.min(Math.max(index, 0), list.length);
  else to = from;
  list.splice(to, 0, item);
  return to !== from ? item : null;
}

class MediaQueue {
  // `decorate(snapshot)`: adds what the panels see but the queue does not own (the button icons).
  // `onFinished(item, { status, progress })`: an item ended ("played" | "skipped" | "error"), told
  // before the next one is chosen. Not told when it was only cut off and will be back.
  constructor({ send, onChange, onFinished, decorate, now = () => Date.now(), random = Math.random } = {}) {
    this.send = send || (() => {});
    this.decorate = decorate || ((snap) => snap);
    this.historyLimit = HISTORY_LIMIT;
    this.onChange = onChange || (() => {});
    this.onFinished = onFinished || (() => {});
    this.now = now;
    this.random = random;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.paused = false;
    this.progress = null; // { time, duration } of the current clip, from the player
    this.lastProgressSave = 0;
    this.nextItemId = 1;
    this.playerCount = 0;
    this.platforms = {}; // { DonationAlerts: { connected, error } } - set by the manager
    // Platform ids already queued, so a reconnect that replays an event does not queue it twice.
    this.seen = new Set();
    this.seenOrder = [];
    // What a moderator picked for the current clip: null (nothing yet), "none" (as is) or one of
    // COVER_MODES. What the player shows is `cover`, below.
    this.coverPick = null;
    this.hideMusic = false;
    this.blurStrength = BLUR_DEFAULT;
    this.volume = VOLUME_DEFAULT;
    // The channel's own playlist: [{ id, videoId, title, author?, seconds? }]; seconds is the length
    // once known.
    this.playlist = [];
    this.nextPlaylistId = 1;
    this.autoPlaylist = false;
    this.playlistBag = []; // playlist ids still to play in this shuffled round
    this.lastPlaylistId = null;
    this.interrupted = null; // { playlistId, time } - the track a donation cut off
    // Tracks that failed in a row. Once every track has failed (all removed or private) the
    // playlist stops instead of cycling through errors forever; any change to it re-arms it.
    this.playlistFailures = 0;
    // The "up next" feed: [{ id, videoId, title, author, source, via, node?, from?, resumeAt? }]. `via`
    // is the action that brought it (UP_NEXT_VIA), `source` the service it came from; `node` and
    // `from` say which step of the music graph it is.
    this.upNext = [];
    this.nextUpId = 1;
    // The radio: null (off) or { seed, cursor, startedAt } - seed and cursor { videoId, title, author }.
    // `cursor` is the last radio track that started: where a top-up comes from when the music graph
    // has nothing.
    this.radio = null;
    this.radioFailures = 0;
    this.infinite = false;
    // What endless music continues from, { videoId, title, author, own }: the feed track that started
    // last, or (own) a playlist track while no feed track has started yet.
    this.lastBackground = null;
    this.recent = []; // videoIds of background tracks played lately, oldest first
    this.played = []; // [{ videoId, title, at }] - everything played within REPEAT_AFTER_MS, oldest first
    // Fetches in flight, by action - set by the manager, shown by the panels.
    this.radioBusy = { radio: false, artist: false, ai: false };
  }

  // --- persistence -------------------------------------------------------------------------------

  // The current donation clip as it goes back to the head of the queue, when the server restarts or
  // the last OBS player disconnects. It carries what a moderator set on it and must find again -
  // the cover and a pause - and the second it had reached, so the stream does not see the part it
  // already saw a second time. That second is only as fresh as the last save: reportProgress saves
  // every PROGRESS_SAVE_MS while a clip plays, and that is the most a restart replays.
  parkedCurrent() {
    const item = { ...this.current };
    if (COVER_MODES.includes(this.coverPick)) item.cover = this.coverPick;
    if (this.paused) item.paused = true;
    const at = this.currentSecond();
    if (at > 0) item.resumeAt = at;
    return item;
  }

  currentSecond() {
    return this.progress && this.progress.time > 0 ? Math.floor(this.progress.time) : 0;
  }

  // What survives a restart. The clip that was playing goes back to the head of the queue (see
  // parkedCurrent); a playlist track that was cut off or interrupted keeps its place the same way.
  toStored() {
    const donation = this.current && !this.current.fromPlaylist ? this.current : null;
    const queue = donation ? [this.parkedCurrent(), ...this.queue] : this.queue;
    const interrupted = this.current && this.current.fromPlaylist && !this.current.upNextEntry ? this.interruptedFromCurrent() : this.interrupted;
    return {
      interrupted: interrupted ? { ...interrupted } : null,
      queue: queue.map(cloneItem),
      history: this.history.map(cloneItem),
      nextItemId: this.nextItemId,
      seen: this.seenOrder.slice(-200),
      playlist: this.playlist.map((p) => ({ ...p })),
      nextPlaylistId: this.nextPlaylistId,
      // Saved so that a restart carries the round on instead of starting a new one with tracks the
      // stream has just heard.
      playlistBag: this.playlistBag.slice(),
      autoPlaylist: this.autoPlaylist,
      infinite: this.infinite,
      hideMusic: this.hideMusic,
      lastBackground: this.lastBackground ? { ...this.lastBackground } : null,
      upNext: this.storedUpNext(),
      nextUpId: this.nextUpId,
      radio: this.radio ? { seed: { ...this.radio.seed }, cursor: { ...this.radio.cursor }, startedAt: this.radio.startedAt } : null,
      recent: this.recent.slice(-RECENT_LIMIT),
      played: this.playedLately().map((p) => ({ ...p })),
      blurStrength: this.blurStrength,
      volume: this.volume,
    };
  }

  restore(stored) {
    if (!stored) return;
    this.queue = Array.isArray(stored.queue) ? stored.queue.slice(0, QUEUE_LIMIT) : [];
    this.history = Array.isArray(stored.history) ? stored.history.slice(0, this.historyLimit) : [];
    const maxId = [...this.queue, ...this.history].reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
    this.nextItemId = Math.max(Number(stored.nextItemId) || 1, maxId + 1);
    for (const key of Array.isArray(stored.seen) ? stored.seen : []) this.remember(key);
    this.playlist = Array.isArray(stored.playlist) ? stored.playlist.slice(0, PLAYLIST_LIMIT) : [];
    const maxPlaylistId = this.playlist.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    this.nextPlaylistId = Math.max(Number(stored.nextPlaylistId) || 1, maxPlaylistId + 1);
    const playlistIds = new Set(this.playlist.map((p) => p.id));
    this.playlistBag = Array.isArray(stored.playlistBag) ? [...new Set(stored.playlistBag)].filter((id) => playlistIds.has(id)) : [];
    this.autoPlaylist = stored.autoPlaylist === true;
    this.infinite = stored.infinite === true;
    this.hideMusic = stored.hideMusic === true;
    const lb = stored.lastBackground;
    this.lastBackground = lb && typeof lb.videoId === "string" ? { videoId: lb.videoId, title: String(lb.title || ""), author: String(lb.author || ""), own: lb.own === undefined ? this.playlist.some((p) => p.videoId === lb.videoId) : lb.own === true } : null;
    this.upNext = Array.isArray(stored.upNext) ? stored.upNext.filter((u) => u && u.videoId).slice(0, UP_NEXT_LIMIT) : [];
    const maxUpId = this.upNext.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0);
    this.nextUpId = Math.max(Number(stored.nextUpId) || 1, maxUpId + 1);
    const radio = stored.radio;
    this.radio = radio && radio.seed && radio.seed.videoId ? { seed: { ...radio.seed }, cursor: { ...(radio.cursor && radio.cursor.videoId ? radio.cursor : radio.seed) }, startedAt: Number(radio.startedAt) || this.now() } : null;
    this.recent = Array.isArray(stored.recent) ? stored.recent.filter((v) => typeof v === "string").slice(-RECENT_LIMIT) : [];
    this.played = Array.isArray(stored.played) ? stored.played.filter((p) => p && typeof p.videoId === "string" && Number.isFinite(p.at)).slice(-PLAYED_LIMIT) : [];
    if (Number.isFinite(stored.blurStrength)) this.blurStrength = clampBlur(stored.blurStrength);
    if (Number.isFinite(stored.volume)) this.volume = clampVolume(stored.volume);
    const cut = stored.interrupted;
    if (cut && this.playlist.some((p) => p.id === cut.playlistId)) {
      this.interrupted = { playlistId: cut.playlistId, time: Number(cut.time) || 0, paused: cut.paused === true };
    }
  }

  // The feed as saved: a radio track playing now goes back to its head, on the second it reached.
  storedUpNext() {
    const list = this.upNext.map((u) => ({ ...u }));
    if (this.current && this.current.upNextEntry) list.unshift(this.parkedUpNext());
    return list.slice(0, UP_NEXT_LIMIT);
  }

  parkedUpNext() {
    const entry = { ...this.current.upNextEntry };
    const at = this.currentSecond();
    if (at > 0) entry.resumeAt = at;
    else delete entry.resumeAt;
    entry.wanted = true; // it has only just played - that must not count against its own return
    if (this.paused) entry.paused = true;
    return entry;
  }

  interruptedFromCurrent() {
    return {
      playlistId: this.current.playlistId,
      time: this.progress ? this.progress.time : 0,
      paused: this.paused,
    };
  }

  remember(key) {
    if (!key || this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 400) {
      for (const old of this.seenOrder.splice(0, 200)) this.seen.delete(old);
    }
  }

  // --- what the panels see -----------------------------------------------------------------------

  snapshot() {
    return this.decorate({
      current: cloneItem(this.current),
      queue: this.queue.map(cloneItem),
      history: this.history.map(cloneItem),
      paused: this.paused,
      progress: this.progress ? { ...this.progress } : null,
      playerConnected: this.playerCount > 0,
      cover: this.cover,
      blurStrength: this.blurStrength,
      volume: this.volume,
      autoPlaylist: this.autoPlaylist,
      playlist: this.playlist.map((p) => ({ ...p })),
      playlistStalled: this.playlistStalled(),
      upNext: this.upNext.map((u) => ({ ...u })),
      radio: this.radio ? { seed: { ...this.radio.seed } } : null,
      radioBusy: { ...this.radioBusy },
      infinite: this.infinite,
      hideMusic: this.hideMusic,
      platforms: JSON.parse(JSON.stringify(this.platforms)),
    });
  }

  // How many finished donations the history keeps (a channel setting, at most HISTORY_LIMIT).
  setHistoryLimit(limit) {
    const n = Math.min(HISTORY_LIMIT, Math.max(1, Math.round(Number(limit)) || HISTORY_LIMIT));
    if (n === this.historyLimit) return;
    this.historyLimit = n;
    if (this.history.length > n) {
      this.history.length = n;
      this.changed();
    }
  }

  broadcastState() {
    this.send("panels", { type: "state", state: this.snapshot() });
  }

  changed() {
    this.broadcastState();
    this.onChange();
  }

  setPlatforms(platforms) {
    this.platforms = platforms || {};
    this.broadcastState();
  }

  // --- the queue ---------------------------------------------------------------------------------

  // media: lib/donationMedia.js's shape. Returns the queued item, or null when it was a repeat or
  // the queue is full.
  // `addedBy`: the moderator's login for a clip added by hand from a panel, or the chatter's for a
  // `viaChat` one (!sr, counted against the per-viewer limit).
  add(platform, media, { dedupeKey = null, addedBy = null, viaChat = false } = {}) {
    if (!media || !media.videoId) return null;
    if (dedupeKey && this.seen.has(dedupeKey)) return null;
    if (this.queue.length >= QUEUE_LIMIT) return null;
    this.remember(dedupeKey);

    const item = {
      id: this.nextItemId++,
      platform,
      videoId: media.videoId,
      title: media.title || "",
      donor: media.donor || "",
      amount: media.amount || null,
      message: media.message || "",
      start: media.start || 0,
      end: media.end || 0, // 0 = to the end of the clip
      addedAt: this.now(),
    };
    if (addedBy) item.addedBy = addedBy;
    if (viaChat) item.viaChat = true;
    this.queue.push(item);
    this.preemptPlaylist();
    this.processQueue();
    this.changed();
    return item;
  }

  // A title learnt later (YouTube oEmbed, or the player reporting it).
  setTitle(id, title) {
    const item = [this.current, ...this.queue].find((i) => i && i.id === id);
    if (!item || !title || item.title === title) return;
    item.title = String(title).slice(0, 200);
    if (item === this.current) this.notePlayed(item);
    if (item.fromPlaylist) {
      const entry = this.playlist.find((p) => p.id === item.playlistId);
      if (entry && !entry.title) entry.title = item.title;
    }
    this.changed();
  }

  processQueue() {
    if (this.current || this.playerCount === 0) return;
    const next = this.queue.length > 0 ? this.queue.shift() : this.nextPlaylistTrack();
    if (!next) return;
    this.current = next;
    this.notePlayed(next);
    // A clip parked while paused (parkedCurrent) comes back paused, on the second it stood on.
    // `resumeAt` only travels in the play message: the item's own `start` stays the donor's cut,
    // which is what seek() keeps as its floor.
    this.paused = next.paused === true;
    const resumeAt = Number(next.resumeAt) || 0;
    this.progress = resumeAt > 0 ? { time: resumeAt, duration: 0 } : null;
    this.coverPick = COVER_MODES.includes(next.cover) ? next.cover : null;
    delete next.cover;
    delete next.paused;
    delete next.resumeAt;
    this.send("players", this.playMessage(resumeAt));
    if (this.cover) this.send("players", this.coverMessage());
  }

  // The cover goes in the same message as the clip (and, for a player page loaded before that,
  // in the "cover" that follows): between two messages the browser may paint a frame, and that
  // frame would show a clip that is meant to be hidden.
  playMessage(resumeAt) {
    return { type: "play", item: this.playMessageItem(resumeAt), cover: this.cover };
  }

  // The current clip as a player is told to start it. `paused` lets the player load it without
  // ever letting it sound: a "pause" sent after a "play" arrives only once it has started.
  playMessageItem(resumeAt = 0) {
    const item = cloneItem(this.current);
    if (resumeAt > (item.start || 0)) item.start = resumeAt;
    if (this.paused) item.paused = true;
    return item;
  }

  // --- the channel's own playlist ------------------------------------------------------------------

  playlistStalled() {
    return this.playlist.length > 0 && this.playlistFailures >= this.playlist.length;
  }

  // A queued clip outranks a playlist track: the track stops where it is and is resumed from that
  // point once the queue has emptied.
  preemptPlaylist() {
    if (!this.current || !this.current.fromPlaylist) return;
    if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
    else this.interrupted = { playlistId: this.current.playlistId, time: this.progress ? this.progress.time : 0 };
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.coverPick = null;
  }

  nextPlaylistTrack() {
    if (!this.autoPlaylist) return null;
    // A playlist track a donation cut off finishes first; then the feed; then, with the feed empty,
    // the playlist.
    const ownAvailable = this.playlist.length > 0 && !this.playlistStalled();
    // Nothing to return to - and a feed must not wait behind it.
    if (this.interrupted && (!ownAvailable || !this.playlist.some((p) => p.id === this.interrupted.playlistId))) this.interrupted = null;
    const played = this.playedIndex();
    // Played while it waited in the feed (a viewer donated the same song, say).
    while (this.upNext.length > 0 && !this.isWanted(this.upNext[0]) && played.has(this.upNext[0])) this.upNext.shift();
    const head = this.upNext[0];
    if (!this.interrupted && head) return this.nextUpNextTrack();
    if (!ownAvailable) return null;
    let entry = null;
    let start = 0;
    let paused = false;
    if (this.interrupted) {
      entry = this.playlist.find((p) => p.id === this.interrupted.playlistId) || null;
      start = entry ? Math.max(0, Math.floor(this.interrupted.time)) : 0;
      paused = Boolean(entry && this.interrupted.paused);
      this.interrupted = null;
    }
    if (!entry) entry = this.pickFromPlaylist(played);
    this.lastPlaylistId = entry.id;
    this.rememberPlayed(entry.videoId);
    if (!this.lastBackground || this.lastBackground.own) this.lastBackground = { videoId: entry.videoId, title: entry.title || "", author: entry.author || "", own: true };
    return {
      ...(paused ? { paused: true } : {}),
      id: this.nextItemId++,
      platform: "playlist",
      fromPlaylist: true,
      playlistId: entry.id,
      videoId: entry.videoId,
      title: entry.title || "",
      donor: "",
      amount: null,
      message: "",
      start,
      end: 0,
      addedAt: this.now(),
    };
  }

  // The next track of the shuffled round that has not played lately. With every one left in the round
  // played (a donation, a radio), one from outside it that has not; failing that too, the one that
  // played longest ago.
  pickFromPlaylist(played) {
    const byId = new Map(this.playlist.map((p) => [p.id, p]));
    this.playlistBag = this.playlistBag.filter((id) => byId.has(id));
    if (this.playlistBag.length === 0) this.refillPlaylistBag();
    const inRound = this.playlistBag.map((id) => byId.get(id));
    const fresh = this.playlist.filter((p) => !played.has(p));
    const entry =
      inRound.find((p) => !played.has(p)) ||
      fresh[Math.floor(this.random() * fresh.length)] ||
      this.playlist.reduce((oldest, p) => (played.order(p) < played.order(oldest) ? p : oldest));
    this.playlistBag = this.playlistBag.filter((id) => id !== entry.id);
    return entry;
  }

  // A feed track that plays whatever was heard lately: cut off halfway, or picked with "play now".
  isWanted(entry) {
    return entry.wanted === true || entry.resumeAt > 0 || entry.paused === true;
  }

  notePlayed(item) {
    this.played = this.playedLately().filter((p) => p.videoId !== item.videoId);
    this.played.push({ videoId: item.videoId, title: item.title || "", at: this.now() });
    if (this.played.length > PLAYED_LIMIT) this.played.splice(0, this.played.length - PLAYED_LIMIT);
  }

  playedLately() {
    const since = this.now() - REPEAT_AFTER_MS;
    return this.played.filter((p) => p.at > since);
  }

  // Lookup by video or by song name: has(track) - played lately; order(track) - the larger, the
  // later (-1: not lately).
  playedIndex() {
    const ids = new Map();
    const keys = new Map();
    this.playedLately().forEach((p, i) => {
      ids.set(p.videoId, i);
      const key = titleKey(p.title);
      if (key) keys.set(key, i);
    });
    const order = (t) => {
      const key = titleKey(t.title);
      return Math.max(ids.has(t.videoId) ? ids.get(t.videoId) : -1, key && keys.has(key) ? keys.get(key) : -1);
    };
    return { order, has: (t) => order(t) !== -1 };
  }

  nextUpNextTrack() {
    const entry = this.upNext.shift();
    const start = Math.max(0, Math.floor(Number(entry.resumeAt) || 0));
    const paused = entry.paused === true;
    delete entry.resumeAt;
    delete entry.paused;
    delete entry.wanted;
    this.rememberPlayed(entry.videoId);
    this.lastBackground = { videoId: entry.videoId, title: entry.title || "", author: entry.author || "", own: false };
    if (this.radio && entry.via === "radio") this.radio.cursor = { videoId: entry.videoId, title: entry.title || "", author: entry.author || "" };
    return {
      ...(paused ? { paused: true } : {}),
      id: this.nextItemId++,
      platform: "radio",
      fromPlaylist: true,
      upNextEntry: entry,
      via: entry.via,
      source: entry.source,
      videoId: entry.videoId,
      title: entry.title || "",
      donor: "",
      amount: null,
      message: "",
      start,
      end: 0,
      addedAt: this.now(),
    };
  }

  rememberPlayed(videoId) {
    if (!videoId) return;
    const at = this.recent.indexOf(videoId);
    if (at !== -1) this.recent.splice(at, 1);
    this.recent.push(videoId);
    if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
  }

  // A shuffled round over the whole playlist (Fisher-Yates). A third of it that played most recently
  // is kept out of the round's first third: a track from the end of one round must not come straight
  // back at the start of the next. The rest of the order stays random - moving the recent ones to
  // the very end would leave them last in every round after.
  refillPlaylistBag() {
    const ids = this.playlist.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const third = Math.floor(ids.length / 3);
    const playedAt = new Map(this.playlist.map((p) => [p.id, this.recent.indexOf(p.videoId)]));
    const fresh = new Set([...ids].sort((a, b) => playedAt.get(a) - playedAt.get(b)).slice(0, ids.length - third));
    const opening = ids.filter((id) => fresh.has(id)).slice(0, third);
    const round = [...opening, ...ids.filter((id) => !opening.includes(id))];
    if (round.length > 1 && round[0] === this.lastPlaylistId) round.push(round.shift());
    this.playlistBag = round;
  }

  setAutoPlaylist(on) {
    const value = on === true;
    if (value === this.autoPlaylist) return;
    this.autoPlaylist = value;
    this.playlistFailures = 0;
    if (!value) {
      this.interrupted = null;
      if (this.current && this.current.fromPlaylist) {
        if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
        this.send("players", { type: "stop" });
        this.current = null;
        this.paused = false;
        this.progress = null;
        this.coverPick = null;
      }
    }
    this.processQueue();
    this.changed();
  }

  // Returns the entry, or null for a repeat or a full playlist.
  addToPlaylist(videoId, title = "") {
    if (!videoId || this.playlist.length >= PLAYLIST_LIMIT) return null;
    if (this.playlist.some((p) => p.videoId === videoId)) return null;
    const entry = { id: this.nextPlaylistId++, videoId, title: String(title || "").slice(0, 200) };
    this.playlist.push(entry);
    this.playlistBag.push(entry.id);
    this.playlistFailures = 0;
    this.processQueue();
    this.changed();
    return entry;
  }

  setPlaylistTitle(id, title) {
    const entry = this.playlist.find((p) => p.id === id);
    if (!entry || !title || entry.title) return;
    entry.title = String(title).slice(0, 200);
    this.changed();
  }

  // What was learnt about a track's video: { author, seconds }.
  setPlaylistInfo(videoId, { author, seconds } = {}) {
    const entry = this.playlist.find((p) => p.videoId === videoId);
    if (!entry) return;
    const before = JSON.stringify(entry);
    if (author && !entry.author) entry.author = String(author).slice(0, 100);
    if (seconds > 0 && !entry.seconds) entry.seconds = Math.round(seconds);
    if (JSON.stringify(entry) !== before) this.changed();
  }

  // May the playlist's songs ever be let into endless music - are there enough of them for it to be
  // worth learning how long they are?
  endlessPlaylistPossible() {
    return this.infinite && this.autoPlaylist && !this.radio && this.playlist.length > ENDLESS_PLAYLIST_OVER;
  }

  // The playlist's songs endless music may choose from; [] when they are too few.
  endlessPlaylist() {
    if (!this.endlessPlaylistPossible()) return [];
    const songs = this.playlist.filter((p) => p.title && p.seconds > 0 && p.seconds <= ENDLESS_PLAYLIST_MAX_SECONDS);
    return songs.length > ENDLESS_PLAYLIST_OVER ? songs : [];
  }

  // A track removed while it plays is left to finish.
  removeFromPlaylist(id) {
    const index = this.playlist.findIndex((p) => p.id === id);
    if (index === -1) return;
    this.playlist.splice(index, 1);
    this.playlistBag = this.playlistBag.filter((p) => p !== id);
    this.playlistFailures = 0;
    this.changed();
  }

  // --- the "up next" feed ---------------------------------------------------------------------------

  // What the feed must not be offered again: videoIds and title keys of what is in it, playing, in
  // the playlist or played lately. `repeats`: only REPEAT_AFTER_MS counts as lately, so a track played
  // before that is allowed again. `tail: false`: what replaceRadioTail would take out may come back.
  feedExclusions({ repeats = false, tail = true } = {}) {
    const ids = new Set(this.notAgain(repeats));
    const keys = new Set();
    const add = (videoId, title) => {
      if (videoId) ids.add(videoId);
      const key = title ? titleKey(title) : "";
      if (key) keys.add(key);
    };
    for (const u of this.upNext) if (tail || !this.isRadioTail(u)) add(u.videoId, u.title);
    const allowed = new Set(this.endlessPlaylist());
    for (const p of this.playlist) if (!allowed.has(p)) add(p.videoId, p.title);
    for (const p of this.playedLately()) add(p.videoId, p.title);
    if (this.current) add(this.current.videoId, this.current.title);
    return { exclude: ids, excludeKeys: keys };
  }

  notAgain(repeats) {
    const lately = this.playedLately().map((p) => p.videoId);
    return repeats ? lately : [...this.recent, ...lately];
  }

  // tracks: [{ videoId, title, author, source }] from lib/radioSources.js. Tracks a panel asked for
  // (`via` "artist" / "ai") go in front of the radio's own, which only fills the time after them.
  // `playNow`: the first of them starts at once - background music playing is cut short for it, and
  // the background is switched on if it was off (the panel asked for music, so it plays). A donation
  // playing is never cut. `first`: to the head of the feed without cutting anything. `repeats`: as
  // in feedExclusions. Returns how many were added.
  addUpNext(tracks, via, { playNow = false, first = false, repeats = false } = {}) {
    if (!UP_NEXT_VIA.includes(via) || !Array.isArray(tracks)) return 0;
    // The sources were given feedExclusions(), but a fetch takes seconds and the feed moves meanwhile.
    const have = new Set([...this.upNext.map((u) => u.videoId), ...this.notAgain(repeats)]);
    if (this.current) have.add(this.current.videoId);
    const fresh = [];
    for (const t of tracks) {
      if (!t || !t.videoId || have.has(t.videoId)) continue;
      if (this.upNext.length + fresh.length >= UP_NEXT_LIMIT) break;
      have.add(t.videoId);
      fresh.push(this.feedEntry(t, via));
    }
    if (fresh.length === 0) return 0;
    if (via === "radio") this.upNext.push(...fresh);
    else {
      const firstRadio = this.upNext.findIndex((u) => u.via === "radio" && !u.resumeAt);
      this.upNext.splice(firstRadio === -1 ? this.upNext.length : firstRadio, 0, ...fresh);
    }
    if (playNow || first) this.upNext = [...fresh, ...this.upNext.filter((u) => !fresh.includes(u))];
    // Music asked for goes ahead of a playlist track a donation cut off too: "radio" pressed on that
    // donation must not be answered with the old playlist track. Only a top-up leaves it be.
    if (playNow || first || via !== "radio") this.interrupted = null;
    if (playNow) {
      this.cutBackgroundFor();
    } else {
      this.processQueue();
      this.changed();
    }
    return fresh.length;
  }

  feedEntry(t, via) {
    const entry = {
      id: this.nextUpId++,
      videoId: t.videoId,
      title: String(t.title || "").slice(0, 200),
      author: String(t.author || "").slice(0, 100),
      source: String(t.source || ""),
      via,
    };
    if (t.node) entry.node = t.node;
    if (t.from) entry.from = t.from;
    return entry;
  }

  // A track the radio chose for itself and nobody has touched.
  isRadioTail(entry) {
    return entry.via === "radio" && !this.isWanted(entry);
  }

  // Puts a track of the feed in front of another, as move() does for the queue. A person has placed
  // it: it plays there whatever was heard lately, and a skip does not choose another in its stead.
  moveUpNext(id, place) {
    const entry = moveIn(this.upNext, id, place);
    if (!entry) return;
    entry.wanted = true;
    this.changed();
  }

  // The radio's own part of the feed, chosen anew (a skip has changed the weights), around what stays
  // where it is. Nothing is announced: the caller is in the middle of a change that will be.
  replaceRadioTail(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return;
    const old = this.upNext.filter((u) => this.isRadioTail(u));
    // A track that stays keeps its id, or a panel's button pressed at this moment would miss it.
    const next = tracks.map((t) => old.find((u) => u.videoId === t.videoId) || this.feedEntry(t, "radio"));
    const around = this.upNext.map((u) => (this.isRadioTail(u) ? next.shift() : u)).filter(Boolean);
    this.upNext = [...around, ...next].slice(0, UP_NEXT_LIMIT);
  }

  // Makes the head of the feed play now (see addUpNext's playNow).
  cutBackgroundFor() {
    if (!this.autoPlaylist) {
      this.setAutoPlaylist(true);
      return;
    }
    if (this.current && this.current.fromPlaylist) {
      if (this.current.upNextEntry) this.upNext.splice(1, 0, this.parkedUpNext());
      this.send("players", { type: "stop" });
      this.current = null;
      this.paused = false;
      this.progress = null;
      this.coverPick = null;
    }
    this.processQueue();
    this.changed();
  }

  // Radio on from a seed track: the old radio's tracks leave the feed (the ones a panel asked for
  // stay). The first top-up is added with playNow by the manager.
  startRadio(seed) {
    if (!seed || !seed.videoId) return;
    const s = { videoId: seed.videoId, title: String(seed.title || "").slice(0, 200), author: String(seed.author || "").slice(0, 100) };
    this.radio = { seed: s, cursor: { ...s }, startedAt: this.now() };
    this.radioFailures = 0;
    this.upNext = this.upNext.filter((u) => u.via !== "radio" || u.resumeAt);
    this.changed();
  }

  stopRadio() {
    if (!this.radio) return;
    this.radio = null;
    this.upNext = this.upNext.filter((u) => u.via !== "radio");
    this.changed();
  }

  // The seed for a top-up without the music graph, or null when the feed has enough. The radio tops up from its
  // cursor; endless music, with no radio on, from lastBackground (or, before anything has played, from
  // a track of the own playlist) - and only while the background is switched on.
  radioWantsMore() {
    if (this.radio) {
      const left = this.upNext.filter((u) => u.via === "radio").length;
      return left < RADIO_LOW_WATER ? { ...this.radio.cursor } : null;
    }
    if (!this.infinite || !this.autoPlaylist || this.upNext.length >= RADIO_LOW_WATER) return null;
    if (this.lastBackground) return { ...this.lastBackground };
    const own = this.playlist[Math.floor(this.random() * this.playlist.length)];
    return own ? { videoId: own.videoId, title: own.title || "", author: "" } : null;
  }

  // Every seed worth asking, in order, for when the first one's Mix holds nothing new: the radio's
  // first track, the last track waiting in the feed and - endless music only - a track of the own
  // playlist, so a video without a usable Mix cannot hold the feed up.
  topUpSeeds() {
    const first = this.radioWantsMore();
    if (!first) return [];
    const seeds = [first];
    const add = (t) => {
      if (t && !seeds.some((s) => s.videoId === t.videoId)) seeds.push({ videoId: t.videoId, title: t.title || "", author: t.author || "" });
    };
    if (this.radio) add(this.radio.seed);
    add(this.upNext[this.upNext.length - 1]);
    if (!this.radio) add(this.playlist[Math.floor(this.random() * this.playlist.length)]);
    return seeds;
  }

  // Endless music on also switches the background on - it is music that plays by itself.
  setInfinite(on) {
    const value = on === true;
    if (value === this.infinite) return;
    this.infinite = value;
    if (value && !this.autoPlaylist) {
      this.setAutoPlaylist(true);
      return;
    }
    this.changed();
  }


  setRadioBusy(kind, busy) {
    if (!(kind in this.radioBusy) || this.radioBusy[kind] === busy) return;
    this.radioBusy[kind] = busy;
    this.broadcastState();
  }

  removeUpNext(id) {
    const at = this.upNext.findIndex((u) => u.id === id);
    if (at === -1) return null;
    const [entry] = this.upNext.splice(at, 1);
    this.changed();
    return entry;
  }

  clearUpNext() {
    if (this.upNext.length === 0) return;
    this.upNext = [];
    this.changed();
  }

  // "Play now": the track goes to the head of the feed and, if background music is playing, it is
  // cut short for it. A donation playing is never cut - the track simply plays next.
  playUpNextNow(id) {
    const at = this.upNext.findIndex((u) => u.id === id);
    if (at === -1) return null;
    const [entry] = this.upNext.splice(at, 1);
    this.upNext.unshift(entry);
    entry.wanted = true;
    this.interrupted = null;
    this.cutBackgroundFor();
    return entry;
  }

  // --- the picture over the current clip -----------------------------------------------------------

  // What the OBS player shows over the current clip: a moderator's pick, else the channel's rule.
  get cover() {
    if (!this.current) return null;
    if (this.coverPick) return this.coverPick === "none" ? null : this.coverPick;
    return this.hideMusic && !isDonation(this.current) ? "hide" : null;
  }

  setCover(mode) {
    if (!this.current) return;
    const value = COVER_MODES.includes(mode) ? mode : null;
    if (value === this.cover) return;
    this.coverPick = value || "none";
    this.send("players", this.coverMessage());
    // changed(), not only a broadcast: the cover rides on the saved queue (parkedCurrent), and a
    // save that never runs is a cover that a restart takes off.
    this.changed();
  }

  // Takes effect on the track already playing too. Switching it on also overrules an "as is" picked
  // earlier for that track; a cover picked by hand stays through either switch.
  setHideMusic(on) {
    const value = on === true;
    if (value === this.hideMusic) return;
    const before = this.cover;
    this.hideMusic = value;
    if (value && this.coverPick === "none") this.coverPick = null;
    if (this.cover !== before) this.send("players", this.coverMessage());
    this.changed();
  }

  coverMessage() {
    return { type: "cover", mode: this.cover, blur: this.blurStrength };
  }

  setBlurStrength(value) {
    if (!Number.isFinite(value)) return;
    const next = clampBlur(value);
    if (next === this.blurStrength) return;
    this.blurStrength = next;
    if (this.cover === "blur") this.send("players", this.coverMessage());
    this.changed();
  }

  // --- sound --------------------------------------------------------------------------------------

  setVolume(value) {
    if (!Number.isFinite(value)) return;
    const next = clampVolume(value);
    if (next === this.volume) return;
    this.volume = next;
    this.send("players", { type: "volume", value: next });
    this.changed();
  }

  // `by`: who skipped or removed it, shown in the history so a panel shared by several moderators
  // can tell what happened to a donation.
  pushHistory(item, status, by = null) {
    const entry = { ...cloneItem(item), status, finishedAt: this.now() };
    if (by) entry.by = by;
    this.history.unshift(entry);
    if (this.history.length > this.historyLimit) this.history.length = this.historyLimit;
  }

  finishCurrent(status, by = null) {
    if (!this.current) return;
    if (this.current.upNextEntry) {
      if (status === "error") this.radioFailures++;
      else if (status === "played") this.radioFailures = 0;
      if (this.radioFailures >= RADIO_MAX_FAILURES) {
        this.radio = null;
        this.radioFailures = 0;
        this.upNext = this.upNext.filter((u) => u.via !== "radio");
      }
    } else if (this.current.fromPlaylist) {
      if (status === "error") this.playlistFailures++;
      else if (status === "played") this.playlistFailures = 0;
    } else {
      this.pushHistory(this.current, status, by);
    }
    this.notePlayed(this.current); // REPEAT_AFTER_MS runs from the end of a track, not from its start
    this.onFinished(this.current, { status, progress: this.progress ? { ...this.progress } : null });
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.coverPick = null;
    this.processQueue();
    this.changed();
  }

  // --- players -----------------------------------------------------------------------------------

  // `sendToJoined` reaches only the player that just connected.
  playerJoined(sendToJoined) {
    this.playerCount++;
    // First, so the clip below starts at the channel's volume rather than at YouTube's full one.
    sendToJoined({ type: "volume", value: this.volume });
    if (this.current) {
      // From where the clip stands, so a second source shows the same frame as the first.
      sendToJoined(this.playMessage(this.currentSecond()));
      if (this.paused) sendToJoined({ type: "pause" });
      if (this.cover) sendToJoined(this.coverMessage());
      this.broadcastState();
    } else {
      this.processQueue();
      this.changed();
    }
  }

  playerLeft() {
    this.playerCount = Math.max(0, this.playerCount - 1);
    if (this.playerCount === 0 && this.current) {
      if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
      else if (this.current.fromPlaylist) this.interrupted = this.interruptedFromCurrent();
      else this.queue.unshift(this.parkedCurrent());
      this.current = null;
      this.paused = false;
      this.progress = null;
      this.coverPick = null;
      this.changed();
      return;
    }
    this.broadcastState();
  }

  videoEnded({ id, error } = {}) {
    if (!this.current) return;
    if (id !== undefined && id !== this.current.id) return;
    this.finishCurrent(error ? "error" : "played");
  }

  reportProgress({ id, time, duration, title } = {}) {
    if (!this.current || id !== this.current.id) return;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    this.progress = { time: n(time), duration: n(duration) };
    const own = this.current.fromPlaylist && this.playlist.find((p) => p.videoId === this.current.videoId);
    if (own && !own.seconds && this.progress.duration > 0) own.seconds = Math.round(this.progress.duration);
    // The saved queue carries the playing clip's second (parkedCurrent), and nothing else would
    // save it while a clip simply plays on.
    if (!this.paused && this.now() - this.lastProgressSave >= PROGRESS_SAVE_MS) {
      this.lastProgressSave = this.now();
      this.onChange();
    }
    if (title && !this.current.title) {
      this.setTitle(this.current.id, title);
      return;
    }
    this.send("panels", { type: "progress", id: this.current.id, ...this.progress });
  }

  // --- panel commands ----------------------------------------------------------------------------

  pause() {
    if (!this.current || this.paused) return;
    this.paused = true;
    this.send("players", { type: "pause" });
    // Saved, not only broadcast: a pause that never reaches Mongo is undone by the next restart -
    // the clip comes back as an ordinary queued one and the first player to connect plays it.
    this.changed();
  }

  resume() {
    if (!this.current || !this.paused) return;
    this.paused = false;
    this.send("players", { type: "resume" });
    this.changed();
  }

  skip(by = null) {
    if (!this.current) return;
    this.send("players", { type: "stop" });
    this.finishCurrent("skipped", by);
  }

  seek(time) {
    if (!this.current) return;
    const t = Number(time);
    // A donor's clip may be cut to start at some second, and that start is the floor; a resumed
    // playlist track's start is only where it was cut off, and the whole track is the channel's.
    const floor = this.current.fromPlaylist ? 0 : this.current.start || 0;
    const target = Math.max(Number.isFinite(t) && t > 0 ? t : 0, floor);
    this.send("players", { type: "seek", time: target });
  }

  replay(id, { next = false } = {}) {
    const source = this.history.find((h) => h.id === id);
    if (!source || this.queue.length >= QUEUE_LIMIT) return;
    const { status, finishedAt, by, ...rest } = cloneItem(source);
    const item = { ...rest, id: this.nextItemId++, addedAt: this.now(), replay: true };
    if (next) this.queue.unshift(item);
    else this.queue.push(item);
    this.preemptPlaylist();
    this.processQueue();
    this.changed();
  }

  remove(id, by = null) {
    const index = this.queue.findIndex((q) => q.id === id);
    if (index === -1) return;
    const [removed] = this.queue.splice(index, 1);
    this.pushHistory(removed, "removed", by);
    this.changed();
  }

  moveTop(id) {
    this.move(id, { index: 0 });
  }

  // Puts a queued item in front of `beforeId` (null = at the end). The panel names its new
  // neighbour rather than an index: a clip can start playing or be removed while a moderator is
  // still dragging, and that shifts every index by one, while the neighbour is still the one they
  // dropped it next to. `index` is the fallback for a neighbour that has since left the queue.
  move(id, place) {
    if (moveIn(this.queue, id, place)) this.changed();
  }

  clearHistory() {
    if (this.history.length === 0) return;
    this.history = [];
    this.changed();
  }
}

module.exports = { MediaQueue, isDonation, HISTORY_LIMIT, QUEUE_LIMIT, PLAYLIST_LIMIT, UP_NEXT_LIMIT, ENDLESS_PLAYLIST_OVER, ENDLESS_PLAYLIST_MAX_SECONDS, RADIO_LOW_WATER, REPEAT_AFTER_MS, RADIO_MAX_FAILURES, COVER_MODES, BLUR_DEFAULT, BLUR_MIN, BLUR_MAX, VOLUME_DEFAULT };
