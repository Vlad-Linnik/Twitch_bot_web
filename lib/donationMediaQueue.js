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
// `cover` is what the OBS player shows over the current clip: null (the clip as is), "hide",
// "blur" or "image" (a placeholder). The sound goes on in every mode - it is for a clip whose
// picture is not fit for the stream. It belongs to one clip and is reset when the next one starts -
// but it travels with that clip when the clip goes back into the queue (the OBS source reloaded,
// a restart), because the clip then starts over, and a hidden clip must not come back uncovered.

const HISTORY_LIMIT = 50;
// A paid donation is never dropped for being one too many, but a runaway source (a test button
// held down, a platform replaying its backlog) must not grow one channel's state without bound -
// it is persisted whole on every change.
const QUEUE_LIMIT = 500;
const PLAYLIST_LIMIT = 300;
const COVER_MODES = ["hide", "blur", "image"];
// How strong "blur" is, in percent. A channel setting rather than a per-clip one: it is chosen once
// to suit the OBS scene, then just used. The player turns the percentage into pixels.
const BLUR_DEFAULT = 60;
const BLUR_MIN = 10;
const BLUR_MAX = 100;
// How often a playing clip's position is saved: the most of it a server restart makes the stream
// see twice. The player reports every second; a save a second would be a Mongo write per second
// per channel for the whole stream.
const PROGRESS_SAVE_MS = 5000;

function clampBlur(value) {
  return Math.min(BLUR_MAX, Math.max(BLUR_MIN, Math.round(Number(value))));
}

function cloneItem(item) {
  return item ? { ...item, amount: item.amount ? { ...item.amount } : null } : null;
}

class MediaQueue {
  constructor({ send, onChange, now = () => Date.now(), random = Math.random } = {}) {
    this.send = send || (() => {});
    this.onChange = onChange || (() => {});
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
    this.cover = null;
    this.blurStrength = BLUR_DEFAULT;
    // The channel's own playlist: [{ id, videoId, title }].
    this.playlist = [];
    this.nextPlaylistId = 1;
    this.autoPlaylist = false;
    this.playlistBag = []; // playlist ids still to play in this shuffled round
    this.lastPlaylistId = null;
    this.interrupted = null; // { playlistId, time } - the track a donation cut off
    // Tracks that failed in a row. Once every track has failed (all removed or private) the
    // playlist stops instead of cycling through errors forever; any change to it re-arms it.
    this.playlistFailures = 0;
  }

  // --- persistence -------------------------------------------------------------------------------

  // The current donation clip as it goes back to the head of the queue, when the server restarts or
  // the last OBS player disconnects. It carries what a moderator set on it and must find again -
  // the cover and a pause - and the second it had reached, so the stream does not see the part it
  // already saw a second time. That second is only as fresh as the last save: reportProgress saves
  // every PROGRESS_SAVE_MS while a clip plays, and that is the most a restart replays.
  parkedCurrent() {
    const item = { ...this.current };
    if (this.cover) item.cover = this.cover;
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
    const interrupted = this.current && this.current.fromPlaylist ? this.interruptedFromCurrent() : this.interrupted;
    return {
      interrupted: interrupted ? { ...interrupted } : null,
      queue: queue.map(cloneItem),
      history: this.history.map(cloneItem),
      nextItemId: this.nextItemId,
      seen: this.seenOrder.slice(-200),
      playlist: this.playlist.map((p) => ({ ...p })),
      nextPlaylistId: this.nextPlaylistId,
      autoPlaylist: this.autoPlaylist,
      blurStrength: this.blurStrength,
    };
  }

  restore(stored) {
    if (!stored) return;
    this.queue = Array.isArray(stored.queue) ? stored.queue.slice(0, QUEUE_LIMIT) : [];
    this.history = Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [];
    const maxId = [...this.queue, ...this.history].reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
    this.nextItemId = Math.max(Number(stored.nextItemId) || 1, maxId + 1);
    for (const key of Array.isArray(stored.seen) ? stored.seen : []) this.remember(key);
    this.playlist = Array.isArray(stored.playlist) ? stored.playlist.slice(0, PLAYLIST_LIMIT) : [];
    const maxPlaylistId = this.playlist.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    this.nextPlaylistId = Math.max(Number(stored.nextPlaylistId) || 1, maxPlaylistId + 1);
    this.autoPlaylist = stored.autoPlaylist === true;
    if (Number.isFinite(stored.blurStrength)) this.blurStrength = clampBlur(stored.blurStrength);
    const cut = stored.interrupted;
    if (cut && this.playlist.some((p) => p.id === cut.playlistId)) {
      this.interrupted = { playlistId: cut.playlistId, time: Number(cut.time) || 0, paused: cut.paused === true };
    }
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
    return {
      current: cloneItem(this.current),
      queue: this.queue.map(cloneItem),
      history: this.history.map(cloneItem),
      paused: this.paused,
      progress: this.progress ? { ...this.progress } : null,
      playerConnected: this.playerCount > 0,
      cover: this.cover,
      blurStrength: this.blurStrength,
      autoPlaylist: this.autoPlaylist,
      playlist: this.playlist.map((p) => ({ ...p })),
      playlistStalled: this.playlistStalled(),
      platforms: JSON.parse(JSON.stringify(this.platforms)),
    };
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
  // `addedBy`: the moderator's login for a clip added by hand from a panel.
  add(platform, media, { dedupeKey = null, addedBy = null } = {}) {
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
    // A clip parked while paused (parkedCurrent) comes back paused, on the second it stood on.
    // `resumeAt` only travels in the play message: the item's own `start` stays the donor's cut,
    // which is what seek() keeps as its floor.
    this.paused = next.paused === true;
    const resumeAt = Number(next.resumeAt) || 0;
    this.progress = resumeAt > 0 ? { time: resumeAt, duration: 0 } : null;
    this.cover = COVER_MODES.includes(next.cover) ? next.cover : null;
    delete next.cover;
    delete next.paused;
    delete next.resumeAt;
    this.send("players", { type: "play", item: this.playMessageItem(resumeAt) });
    if (this.cover) this.send("players", this.coverMessage());
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
    this.interrupted = { playlistId: this.current.playlistId, time: this.progress ? this.progress.time : 0 };
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.cover = null;
  }

  nextPlaylistTrack() {
    if (!this.autoPlaylist || this.playlist.length === 0 || this.playlistStalled()) return null;
    let entry = null;
    let start = 0;
    let paused = false;
    if (this.interrupted) {
      entry = this.playlist.find((p) => p.id === this.interrupted.playlistId) || null;
      start = entry ? Math.max(0, Math.floor(this.interrupted.time)) : 0;
      paused = Boolean(entry && this.interrupted.paused);
      this.interrupted = null;
    }
    while (!entry) {
      if (this.playlistBag.length === 0) this.refillPlaylistBag();
      const id = this.playlistBag.shift();
      entry = this.playlist.find((p) => p.id === id) || null;
    }
    this.lastPlaylistId = entry.id;
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

  // A shuffled round over the whole playlist (Fisher-Yates), never opening with the track that
  // just closed the previous round.
  refillPlaylistBag() {
    const ids = this.playlist.map((p) => p.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    if (ids.length > 1 && ids[0] === this.lastPlaylistId) ids.push(ids.shift());
    this.playlistBag = ids;
  }

  setAutoPlaylist(on) {
    const value = on === true;
    if (value === this.autoPlaylist) return;
    this.autoPlaylist = value;
    this.playlistFailures = 0;
    if (!value) {
      this.interrupted = null;
      if (this.current && this.current.fromPlaylist) {
        this.send("players", { type: "stop" });
        this.current = null;
        this.paused = false;
        this.progress = null;
        this.cover = null;
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

  // A track removed while it plays is left to finish.
  removeFromPlaylist(id) {
    const index = this.playlist.findIndex((p) => p.id === id);
    if (index === -1) return;
    this.playlist.splice(index, 1);
    this.playlistBag = this.playlistBag.filter((p) => p !== id);
    this.playlistFailures = 0;
    this.changed();
  }

  // --- the picture over the current clip -----------------------------------------------------------

  setCover(mode) {
    if (!this.current) return;
    const value = COVER_MODES.includes(mode) ? mode : null;
    if (value === this.cover) return;
    this.cover = value;
    this.send("players", this.coverMessage());
    // changed(), not only a broadcast: the cover rides on the saved queue (parkedCurrent), and a
    // save that never runs is a cover that a restart takes off.
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

  // `by`: who skipped or removed it, shown in the history so a panel shared by several moderators
  // can tell what happened to a donation.
  pushHistory(item, status, by = null) {
    const entry = { ...cloneItem(item), status, finishedAt: this.now() };
    if (by) entry.by = by;
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  finishCurrent(status, by = null) {
    if (!this.current) return;
    if (this.current.fromPlaylist) {
      if (status === "error") this.playlistFailures++;
      else if (status === "played") this.playlistFailures = 0;
    } else {
      this.pushHistory(this.current, status, by);
    }
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.cover = null;
    this.processQueue();
    this.changed();
  }

  // --- players -----------------------------------------------------------------------------------

  // `sendToJoined` reaches only the player that just connected.
  playerJoined(sendToJoined) {
    this.playerCount++;
    if (this.current) {
      // From where the clip stands, so a second source shows the same frame as the first.
      sendToJoined({ type: "play", item: this.playMessageItem(this.currentSecond()) });
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
      if (this.current.fromPlaylist) this.interrupted = this.interruptedFromCurrent();
      else this.queue.unshift(this.parkedCurrent());
      this.current = null;
      this.paused = false;
      this.progress = null;
      this.cover = null;
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
  move(id, { beforeId = null, index = null } = {}) {
    const from = this.queue.findIndex((q) => q.id === id);
    if (from === -1 || beforeId === id) return;
    const [item] = this.queue.splice(from, 1);
    let to;
    if (beforeId === null && index === null) to = this.queue.length;
    else if (beforeId !== null && this.queue.some((q) => q.id === beforeId)) to = this.queue.findIndex((q) => q.id === beforeId);
    else if (Number.isInteger(index)) to = Math.min(Math.max(index, 0), this.queue.length);
    else to = from;
    this.queue.splice(to, 0, item);
    if (to !== from) this.changed();
  }

  clearHistory() {
    if (this.history.length === 0) return;
    this.history = [];
    this.changed();
  }
}

module.exports = { MediaQueue, HISTORY_LIMIT, QUEUE_LIMIT, PLAYLIST_LIMIT, COVER_MODES, BLUR_DEFAULT, BLUR_MIN, BLUR_MAX };
