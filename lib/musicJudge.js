// What the choice of a track is tilted by beyond the walk (lib/musicGraph.js): a factor its chance is
// multiplied by, and the numbers behind it for the journal. The numbers are noted whether their tilt is
// on for this batch or not (lib/musicFeatures.js), or the two halves could not be compared.
const { cosine, mean, blend } = require("./musicTags");
const { artistOf } = require("./musicGraph");

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const round = (v) => Number(v.toPrecision(3));

// Likeness to the roots by genre: from GENRE_MIN at none to GENRE_MAX at GENRE_FULL and above. Unknown: 1.
// Never out - a namesake's tags are somebody else's.
const GENRE_MIN = 0.6;
const GENRE_MAX = 1.3;
const GENRE_FULL = 0.6;
// After skips in a row, for a song wholly of the skipped ones' genre.
const STREAK_LEAVE = 2;
const STREAK_GENRE = 0.5;
// For a song the channel has not heard, wholly of the genres it likes - or, the other way, skips.
const LIKED_GENRE = 0.3;
const LIKED_FULL = 4; // so much taste in all for that to be in full
const LIKED_SONGS = 150;
const NEIGHBOURS = 12;
// Further off than this a song is not judged by genre: there are a thousand of them, and hardly any play.
const JUDGED_REACH = 0.02;

class MusicJudge {
  constructor({ graph, tags }) {
    this.graph = graph;
    this.tags = tags;
    this.vectors = new Map();
    this.vectorsKey = null;
    this.liked = { key: null, value: null };
    this.state = { key: null, value: null };
  }

  // A node's genre, its neighbours' word included; null when nothing is known around it.
  genreOf(node) {
    if (!this.tags || !node) return null;
    const key = `${this.graph.shape}|${this.tags.version}`;
    if (key !== this.vectorsKey) {
      this.vectorsKey = key;
      this.vectors.clear();
    }
    if (!this.vectors.has(node.id)) {
      const around = this.graph.neighboursOf(node.id, NEIGHBOURS).filter(([n]) => n.artist !== node.artist);
      this.vectors.set(node.id, blend(this.tags.get(node.artist), around.map(([n, s]) => [this.tags.get(n.artist), s])));
    }
    return this.vectors.get(node.id);
  }

  // Songs whose artists' tags the channel's own genres are made of.
  tasteSongs() {
    return [...this.graph.taste.entries()]
      .map(([id, rec]) => ({ artist: artistOf(rec.title, rec.author), score: this.graph.trackScore(id) }))
      .filter((t) => t.artist && Math.abs(t.score) > 0.15)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, LIKED_SONGS);
  }

  // { vector, strength 0..1 }: the genres the channel hears to the end, less those it skips.
  likedGenres() {
    const key = `${this.graph.taste.size}|${this.graph.version}|${this.tags.version}`;
    if (this.liked.key !== key) {
      const songs = this.tasteSongs().map((t) => [this.tags.get(t.artist), t.score]).filter(([v]) => v);
      const total = songs.reduce((sum, [, score]) => sum + Math.abs(score), 0);
      this.liked = { key, value: songs.length > 0 ? { vector: mean(songs), strength: Math.min(1, total / LIKED_FULL) } : null };
    }
    return this.liked.value;
  }

  rootGenre(roots) {
    return mean((roots || []).map((r) => {
      const [id] = this.graph.rootIds([r]);
      return [id ? this.genreOf(this.graph.nodes.get(id)) : null, r.weight > 0 ? r.weight : 1];
    }));
  }

  // What stays the same for every song of one choice.
  prepare(roots, arms) {
    const g = this.graph;
    const key = JSON.stringify([g.version, g.shape, this.tags ? this.tags.version : 0, g.streak, arms, (roots || []).map((r) => [r.videoId, r.weight])]);
    if (this.state.key === key) return this.state.value;
    const streak = g.streak.length >= STREAK_LEAVE ? mean(g.streak.map((id) => [this.genreOf(g.nodes.get(id)), 1])) : null;
    const value = { reach: g.rank(roots).reach, root: this.rootGenre(roots), streak, liked: this.tags ? this.likedGenres() : null };
    this.state = { key, value };
    return value;
  }

  // For MusicGraph.pick: (node) => { factor, ...notes }.
  for(roots, { arms = {} } = {}) {
    return (node) => {
      const state = this.prepare(roots, arms);
      const reach = state.reach.get(node.id) || 0;
      let factor = 1;
      const notes = { arms };
      const genre = reach >= JUDGED_REACH ? this.genreOf(node) : null;
      const sim = cosine(state.root, genre);
      if (sim !== null) notes.sim = round(sim);
      if (arms.tags) factor *= this.genreFactor(node, genre, sim, state);
      return { factor, ...notes };
    };
  }

  genreFactor(node, genre, sim, state) {
    let factor = 1;
    if (sim !== null) factor *= GENRE_MIN + (GENRE_MAX - GENRE_MIN) * clamp(sim / GENRE_FULL, 0, 1);
    const skipped = cosine(state.streak, genre);
    if (skipped !== null) factor *= 1 - STREAK_GENRE * clamp(skipped, 0, 1);
    const liked = state.liked && !this.graph.isHeard(node) ? cosine(state.liked.vector, genre) : null;
    if (liked !== null) factor *= Math.exp(LIKED_GENRE * state.liked.strength * liked);
    return factor;
  }

  // For MusicGraph.toExpand: what to open first among the equally close.
  prefer(roots, { arms = {} } = {}) {
    return (node) => {
      if (!arms.tags) return 1;
      const sim = cosine(this.prepare(roots, arms).root, this.genreOf(node));
      return sim === null ? 1 : 0.7 + 0.6 * clamp(sim, 0, 1);
    };
  }
}

module.exports = { MusicJudge };
