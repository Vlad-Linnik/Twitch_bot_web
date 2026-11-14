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

const HISTORY_LIMIT = 50;
// A paid donation is never dropped for being one too many, but a runaway source (a test button
// held down, a platform replaying its backlog) must not grow one channel's state without bound -
// it is persisted whole on every change.
const QUEUE_LIMIT = 500;

function cloneItem(item) {
  return item ? { ...item, amount: item.amount ? { ...item.amount } : null } : null;
}

class MediaQueue {
  constructor({ send, onChange, now = () => Date.now() } = {}) {
    this.send = send || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.paused = false;
    this.progress = null; // { time, duration } of the current clip, from the player
    this.nextItemId = 1;
    this.playerCount = 0;
    this.platforms = {}; // { DonationAlerts: { connected, error } } - set by the manager
    // Platform ids already queued, so a reconnect that replays an event does not queue it twice.
    this.seen = new Set();
    this.seenOrder = [];
  }

  // --- persistence -------------------------------------------------------------------------------

  // What survives a restart. The clip that was playing goes back to the head of the queue: after a
  // restart no player is connected yet, and on reconnect it starts from the beginning anyway.
  toStored() {
    const queue = this.current ? [this.current, ...this.queue] : this.queue;
    return {
      queue: queue.map(cloneItem),
      history: this.history.map(cloneItem),
      nextItemId: this.nextItemId,
      seen: this.seenOrder.slice(-200),
    };
  }

  restore(stored) {
    if (!stored) return;
    this.queue = Array.isArray(stored.queue) ? stored.queue.slice(0, QUEUE_LIMIT) : [];
    this.history = Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [];
    const maxId = [...this.queue, ...this.history].reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
    this.nextItemId = Math.max(Number(stored.nextItemId) || 1, maxId + 1);
    for (const key of Array.isArray(stored.seen) ? stored.seen : []) this.remember(key);
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
    this.processQueue();
    this.changed();
    return item;
  }

  // A title learnt later (YouTube oEmbed, or the player reporting it).
  setTitle(id, title) {
    const item = [this.current, ...this.queue].find((i) => i && i.id === id);
    if (!item || !title || item.title === title) return;
    item.title = String(title).slice(0, 200);
    this.changed();
  }

  processQueue() {
    if (this.current || this.queue.length === 0 || this.playerCount === 0) return;
    this.current = this.queue.shift();
    this.paused = false;
    this.progress = null;
    this.send("players", { type: "play", item: cloneItem(this.current) });
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
    this.pushHistory(this.current, status, by);
    this.current = null;
    this.paused = false;
    this.progress = null;
    this.processQueue();
    this.changed();
  }

  // --- players -----------------------------------------------------------------------------------

  // `sendToJoined` reaches only the player that just connected.
  playerJoined(sendToJoined) {
    this.playerCount++;
    if (this.current) {
      sendToJoined({ type: "play", item: cloneItem(this.current) });
      if (this.paused) sendToJoined({ type: "pause" });
      this.broadcastState();
    } else {
      this.processQueue();
      this.changed();
    }
  }

  playerLeft() {
    this.playerCount = Math.max(0, this.playerCount - 1);
    if (this.playerCount === 0 && this.current) {
      this.queue.unshift(this.current);
      this.current = null;
      this.paused = false;
      this.progress = null;
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
    this.broadcastState();
  }

  resume() {
    if (!this.current || !this.paused) return;
    this.paused = false;
    this.send("players", { type: "resume" });
    this.broadcastState();
  }

  skip(by = null) {
    if (!this.current) return;
    this.send("players", { type: "stop" });
    this.finishCurrent("skipped", by);
  }

  seek(time) {
    if (!this.current) return;
    const t = Number(time);
    const target = Math.max(Number.isFinite(t) && t > 0 ? t : 0, this.current.start || 0);
    this.send("players", { type: "seek", time: target });
  }

  replay(id, { next = false } = {}) {
    const source = this.history.find((h) => h.id === id);
    if (!source || this.queue.length >= QUEUE_LIMIT) return;
    const { status, finishedAt, by, ...rest } = cloneItem(source);
    const item = { ...rest, id: this.nextItemId++, addedAt: this.now(), replay: true };
    if (next) this.queue.unshift(item);
    else this.queue.push(item);
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
    const index = this.queue.findIndex((q) => q.id === id);
    if (index <= 0) return;
    const [item] = this.queue.splice(index, 1);
    this.queue.unshift(item);
    this.changed();
  }

  clearHistory() {
    if (this.history.length === 0) return;
    this.history = [];
    this.changed();
  }
}

module.exports = { MediaQueue, HISTORY_LIMIT, QUEUE_LIMIT };
