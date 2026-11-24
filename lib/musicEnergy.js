// How lively a song is, by the song: a model is asked for the energy of fifty at a time, once each for
// every channel (kept in MusicGraphTracks). Asked only while a channel plays by a mood. Measured on 56
// songs: one second, 1200 tokens, "Lonely Day" 4 and "Chop Suey!" 10 of one band - which the artist's
// tags cannot tell apart - and -1 for a song that does not exist.
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 50;
const PER_DAY = 40;
// After a failure, doubled by each one more in a row: the free tier answers 503 now and then.
const PAUSE_MS = 30 * 1000;
const PAUSE_MAX_MS = 10 * 60 * 1000;

// The model's 0..10 as -1..1; null: it does not know.
function fromScore(score) {
  return Number.isFinite(score) && score >= 0 && score <= 10 ? Math.round(((score - 5) / 5) * 100) / 100 : null;
}

class MusicEnergy {
  // source([{ title, author }]) -> [0..10 | -1] of the same length, or throws. repo.saveEnergy([{ videoId,
  // energy }]).
  constructor({ source, repo, now = () => Date.now() }) {
    this.source = source;
    this.repo = repo;
    this.now = now;
    this.day = null;
    this.spent = 0;
    this.askAfter = 0;
    this.failures = 0;
    this.asking = new WeakSet();
  }

  // nodes: lib/musicGraph.js's, the most wanted first. Sets node.energy (null: asked, not known) on up to
  // BATCH of those it is not set on. Returns whether anything was learnt.
  async learn(nodes) {
    const unknown = nodes.filter((n) => n.energy === undefined && !this.asking.has(n)).slice(0, BATCH);
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0;
    }
    if (unknown.length === 0 || this.spent >= PER_DAY || this.now() < this.askAfter) return false;
    this.spent++;
    let scores;
    for (const n of unknown) this.asking.add(n);
    try {
      scores = await this.source(unknown.map((n) => ({ title: n.title, author: n.author })));
      if (!Array.isArray(scores) || scores.length !== unknown.length) throw new Error("not one answer per song");
    } catch (err) {
      this.askAfter = this.now() + Math.min(PAUSE_MAX_MS, PAUSE_MS * 2 ** this.failures++);
      console.error("[musicEnergy] no answer:", err.message);
      return false;
    } finally {
      for (const n of unknown) this.asking.delete(n);
    }
    this.failures = 0;
    unknown.forEach((n, i) => { n.energy = fromScore(scores[i]); });
    this.repo.saveEnergy(unknown.map((n) => ({ videoId: n.videoId, energy: n.energy }))).catch((err) => console.error("[musicEnergy] could not save:", err.message));
    return true;
  }
}

module.exports = { MusicEnergy, fromScore, BATCH, PER_DAY };
