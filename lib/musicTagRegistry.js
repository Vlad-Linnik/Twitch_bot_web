// The artists' tags the music graph uses, for every channel of the process (lib/musicTags.js says what
// they are). In memory what has been asked of Mongo, in Mongo what has been asked of Last.fm; Last.fm is
// asked in the background, one question a second and so many a day, and nobody waits for it: an artist
// not known yet is simply not judged by genre.
const { vectorOf } = require("./musicTags");

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = 120 * DAY_MS;
// Nothing found: a new artist, or a name spelt some other way than on Last.fm.
const EMPTY_FRESH_MS = 14 * DAY_MS;
const PER_DAY = 300;
const SPACING_MS = 1000;
const QUEUE_MAX = 200;
const KNOWN_MAX = 20000;
// After an answer that was no answer (Last.fm is down, the key is refused).
const PAUSE_MS = 10 * 60 * 1000;

class MusicTagRegistry {
  // source(name) -> [{ name, count }] (empty: no such artist or no tags), throws when Last.fm did not
  // answer. repo: db/musicArtistsRepo.js.
  constructor({ repo, source, now = () => Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms).unref()) }) {
    this.repo = repo;
    this.source = source;
    this.now = now;
    this.pause = pause;
    this.known = new Map(); // artist key -> { vector, at, empty } | null (Mongo has nothing)
    this.queue = new Map(); // artist key -> names
    this.version = 0;
    this.working = null;
    this.day = null;
    this.spent = 0;
    this.askAfter = 0;
  }

  // The artist's tags as a vector, or null.
  get(artist) {
    const rec = this.known.get(artist);
    return (rec && rec.vector) || null;
  }

  isStale(artist) {
    const rec = this.known.get(artist);
    return !rec || this.now() - rec.at > (rec.empty ? EMPTY_FRESH_MS : FRESH_MS);
  }

  put(artist, name, raw, at) {
    const vector = vectorOf(raw, name);
    this.known.delete(artist);
    this.known.set(artist, { vector, at, empty: !vector });
    if (this.known.size > KNOWN_MAX) this.known.delete(this.known.keys().next().value);
    this.version++;
  }

  // From Mongo, those not asked for yet.
  async load(artists) {
    const fresh = [...new Set(artists)].filter((a) => a && !this.known.has(a));
    if (fresh.length === 0) return;
    let rows;
    try {
      rows = await this.repo.load(fresh);
    } catch (err) {
      console.error("[musicTags] could not load artists:", err.message);
      return;
    }
    for (const a of fresh) if (!this.known.has(a)) this.known.set(a, null);
    for (const row of rows) this.put(row._id, row.name, row.tags, row.at ? row.at.getTime() : 0);
  }

  // [{ artist, names }], the most wanted first: asked for when their turn comes.
  want(list) {
    for (const { artist, names } of list) {
      if (!artist || names.length === 0 || this.queue.has(artist) || this.queue.size >= QUEUE_MAX || !this.known.has(artist) || !this.isStale(artist)) continue;
      this.queue.set(artist, names);
    }
    if (this.queue.size > 0 && !this.working) {
      this.working = this.work()
        .catch((err) => console.error("[musicTags] failed:", err.message))
        .finally(() => { this.working = null; });
    }
  }

  spend() {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0;
    }
    if (this.spent >= PER_DAY) return false;
    this.spent++;
    return true;
  }

  async work() {
    while (this.queue.size > 0 && this.now() >= this.askAfter) {
      const [artist, names] = this.queue.entries().next().value;
      this.queue.delete(artist);
      let found = { name: names[0], raw: [] };
      for (const name of names) {
        if (!this.spend()) {
          this.queue.clear();
          return;
        }
        let raw;
        try {
          raw = await this.source(name);
        } catch (_) {
          this.askAfter = this.now() + PAUSE_MS;
          this.queue.clear();
          return;
        }
        await this.pause(SPACING_MS);
        if (vectorOf(raw, name)) {
          found = { name, raw };
          break;
        }
      }
      const at = this.now();
      this.put(artist, found.name, found.raw, at);
      await this.repo.save(artist, { name: found.name, tags: found.raw, at: new Date(at) }).catch((err) => console.error("[musicTags] could not save an artist:", err.message));
    }
  }
}

module.exports = { MusicTagRegistry, PER_DAY };
