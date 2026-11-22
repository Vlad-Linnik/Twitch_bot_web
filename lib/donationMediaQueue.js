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
// "Endless music" (`infinite`) keeps the feed from running dry without anyone pressing "radio":
// it is topped up from the Mix of whatever background track played last. So that a playlist of two
// or three tracks neither loops back-to-back nor disappears under the Mix, every INFINITE_OWN_EVERY-th
// background track is taken from the channel's own playlist.
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
const UP_NEXT_LIMIT = 100;
// Recently played videos, never offered again by the feed while they are remembered.
const RECENT_LIMIT = 300;
// While the radio is on, the feed is topped up from the Mix once fewer than this many radio tracks
// are left in it.
const RADIO_LOW_WATER = 3;
// Radio tracks that failed to play in a row before the radio switches itself off: a Mix full of
// tracks the player cannot show must not cycle through errors forever.
const RADIO_MAX_FAILURES = 5;
const UP_NEXT_VIA = ["radio", "artist", "ai"];
const INFINITE_OWN_EVERY = 4;
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
    this.volume = VOLUME_DEFAULT;
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
    // The "up next" feed: [{ id, videoId, title, author, source, via, resumeAt? }]. `via` is the
    // action that brought it (UP_NEXT_VIA), `source` the service it came from.
    this.upNext = [];
    this.nextUpId = 1;
    // The radio: null (off) or { seed, cursor } - each { videoId, title, author }. `cursor` is the
    // last radio track that started, and the next top-up is the Mix of it, so the radio drifts
    // along rather than replaying one Mix.
    this.radio = null;
    this.radioFailures = 0;
    this.infinite = false;
    // The background track that started last, { videoId, title, author }: what endless music
    // continues from.
    this.lastBackground = null;
    this.sinceOwn = 0; // background tracks since the last one from the own playlist
    this.recent = []; // videoIds of background tracks played lately, oldest first
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
    const interrupted = this.current && this.current.fromPlaylist && !this.current.upNextEntry ? this.interruptedFromCurrent() : this.interrupted;
    return {
      interrupted: interrupted ? { ...interrupted } : null,
      queue: queue.map(cloneItem),
      history: this.history.map(cloneItem),
      nextItemId: this.nextItemId,
      seen: this.seenOrder.slice(-200),
      playlist: this.playlist.map((p) => ({ ...p })),
      nextPlaylistId: this.nextPlaylistId,
      autoPlaylist: this.autoPlaylist,
      infinite: this.infinite,
      lastBackground: this.lastBackground ? { ...this.lastBackground } : null,
      upNext: this.storedUpNext(),
      nextUpId: this.nextUpId,
      radio: this.radio ? { seed: { ...this.radio.seed }, cursor: { ...this.radio.cursor } } : null,
      recent: this.recent.slice(-RECENT_LIMIT),
      blurStrength: this.blurStrength,
      volume: this.volume,
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
    this.infinite = stored.infinite === true;
    const lb = stored.lastBackground;
    this.lastBackground = lb && typeof lb.videoId === "string" ? { videoId: lb.videoId, title: String(lb.title || ""), author: String(lb.author || "") } : null;
    this.upNext = Array.isArray(stored.upNext) ? stored.upNext.filter((u) => u && u.videoId).slice(0, UP_NEXT_LIMIT) : [];
    const maxUpId = this.upNext.reduce((m, u) => Math.max(m, Number(u.id) || 0), 0);
    this.nextUpId = Math.max(Number(stored.nextUpId) || 1, maxUpId + 1);
    const radio = stored.radio;
    this.radio = radio && radio.seed && radio.seed.videoId ? { seed: { ...radio.seed }, cursor: { ...(radio.cursor && radio.cursor.videoId ? radio.cursor : radio.seed) } } : null;
    this.recent = Array.isArray(stored.recent) ? stored.recent.filter((v) => typeof v === "string").slice(-RECENT_LIMIT) : [];
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
    return {
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
    if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
    else this.interrupted = { playlistId: this.current.playlistId, time: this.progress ? this.progress.time : 0 };
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.cover = null;
  }

  nextPlaylistTrack() {
    if (!this.autoPlaylist) return null;
    // A playlist track a donation cut off finishes first; then the feed; then the playlist. With
    // endless music on, the playlist also takes every INFINITE_OWN_EVERY-th turn from the feed.
    const ownAvailable = this.playlist.length > 0 && !this.playlistStalled();
    const ownTurn = this.infinite && ownAvailable && this.sinceOwn >= INFINITE_OWN_EVERY - 1;
    if (!this.interrupted && this.upNext.length > 0 && !ownTurn) {
      this.sinceOwn++;
      return this.nextUpNextTrack();
    }
    if (!ownAvailable) return null;
    this.sinceOwn = 0;
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
    this.rememberPlayed(entry.videoId);
    this.lastBackground = { videoId: entry.videoId, title: entry.title || "", author: "" };
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

  nextUpNextTrack() {
    const entry = this.upNext.shift();
    const start = Math.max(0, Math.floor(Number(entry.resumeAt) || 0));
    const paused = entry.paused === true;
    delete entry.resumeAt;
    delete entry.paused;
    this.rememberPlayed(entry.videoId);
    this.lastBackground = { videoId: entry.videoId, title: entry.title || "", author: entry.author || "" };
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
        if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
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

  // --- the "up next" feed ---------------------------------------------------------------------------

  // What the feed must not be offered again: videoIds and title keys of what is in it, playing, in
  // the playlist or played lately. `titleKey` is lib/donationMediaRadio.js's, passed in so this file
  // stays free of it.
  feedExclusions(titleKey) {
    const ids = new Set(this.recent);
    const keys = new Set();
    const add = (videoId, title) => {
      if (videoId) ids.add(videoId);
      const key = title ? titleKey(title) : "";
      if (key) keys.add(key);
    };
    for (const u of this.upNext) add(u.videoId, u.title);
    for (const p of this.playlist) add(p.videoId, p.title);
    if (this.current) add(this.current.videoId, this.current.title);
    return { exclude: ids, excludeKeys: keys };
  }

  // tracks: [{ videoId, title, author, source }] from lib/radioSources.js. Tracks a panel asked for
  // (`via` "artist" / "ai") go in front of the radio's own, which only fills the time after them.
  // `playNow`: the first of them starts at once - background music playing is cut short for it, and
  // the background is switched on if it was off (the panel asked for music, so it plays). A donation
  // playing is never cut. `first`: to the head of the feed without cutting anything. Returns how
  // many were added.
  addUpNext(tracks, via, { playNow = false, first = false } = {}) {
    if (!UP_NEXT_VIA.includes(via) || !Array.isArray(tracks)) return 0;
    // The sources were given feedExclusions(), but a fetch takes seconds and the feed moves meanwhile.
    const have = new Set([...this.upNext.map((u) => u.videoId), ...this.recent]);
    if (this.current) have.add(this.current.videoId);
    const fresh = [];
    for (const t of tracks) {
      if (!t || !t.videoId || have.has(t.videoId)) continue;
      if (this.upNext.length + fresh.length >= UP_NEXT_LIMIT) break;
      have.add(t.videoId);
      fresh.push({
        id: this.nextUpId++,
        videoId: t.videoId,
        title: String(t.title || "").slice(0, 200),
        author: String(t.author || "").slice(0, 100),
        source: String(t.source || ""),
        via,
      });
    }
    if (fresh.length === 0) return 0;
    if (via === "radio") this.upNext.push(...fresh);
    else {
      const firstRadio = this.upNext.findIndex((u) => u.via === "radio" && !u.resumeAt);
      this.upNext.splice(firstRadio === -1 ? this.upNext.length : firstRadio, 0, ...fresh);
    }
    if (playNow || first) this.upNext = [...fresh, ...this.upNext.filter((u) => !fresh.includes(u))];
    if (playNow) {
      // Ahead of a playlist track a donation cut off too.
      this.interrupted = null;
      this.cutBackgroundFor();
    } else {
      this.processQueue();
      this.changed();
    }
    return fresh.length;
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
      this.cover = null;
    }
    this.processQueue();
    this.changed();
  }

  // Radio on from a seed track: the old radio's tracks leave the feed (the ones a panel asked for
  // stay). The first top-up is added with playNow by the manager.
  startRadio(seed) {
    if (!seed || !seed.videoId) return;
    const s = { videoId: seed.videoId, title: String(seed.title || "").slice(0, 200), author: String(seed.author || "").slice(0, 100) };
    this.radio = { seed: s, cursor: { ...s } };
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

  // The seed for the next top-up, or null when the radio has enough (or is off).
  // The seed for the next top-up, or null when the feed has enough. The radio tops up from its
  // cursor; endless music, with no radio on, from the background track that played last (or, before
  // anything has, from a track of the own playlist) - and only while the background is switched on.
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

  // Endless music on also switches the background on - it is music that plays by itself.
  setInfinite(on) {
    const value = on === true;
    if (value === this.infinite) return;
    this.infinite = value;
    this.sinceOwn = 0;
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
    if (at === -1) return;
    this.upNext.splice(at, 1);
    this.changed();
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
    if (at === -1) return;
    const [entry] = this.upNext.splice(at, 1);
    this.upNext.unshift(entry);
    this.interrupted = null;
    this.cutBackgroundFor();
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
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
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
    // First, so the clip below starts at the channel's volume rather than at YouTube's full one.
    sendToJoined({ type: "volume", value: this.volume });
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
      if (this.current.upNextEntry) this.upNext.unshift(this.parkedUpNext());
      else if (this.current.fromPlaylist) this.interrupted = this.interruptedFromCurrent();
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

module.exports = { MediaQueue, HISTORY_LIMIT, QUEUE_LIMIT, PLAYLIST_LIMIT, UP_NEXT_LIMIT, RADIO_LOW_WATER, RADIO_MAX_FAILURES, INFINITE_OWN_EVERY, COVER_MODES, BLUR_DEFAULT, BLUR_MIN, BLUR_MAX, VOLUME_DEFAULT };
