// What the choice of a track is tilted by beyond the walk (lib/musicGraph.js): a factor its chance is
// multiplied by, and the numbers behind it for the journal. The numbers are noted whether their tilt is
// on for this batch or not (lib/musicFeatures.js), or the two halves could not be compared.
const { cosine, mean, blend, energyOf } = require("./musicTags");
const { artistOf, songId } = require("./musicGraph");

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
// A mood asked for. What is close to a song is mostly as lively as it is, so weighing that changes
// nothing: the fitting songs are told from the others - by MOOD_STEP from the root, within MOOD_BOUNDS - and the radio
// looks for more until it has enough of them (MusicRadio.stockOf, toExpand by prefer). Those that do not
// fit play only when there is nothing else.
const MOOD_STEP = 0.25;
const MOOD_BOUNDS = { calm: [-0.2, 0.3], lively: [0.2, 0.7] };
const MOOD_SLOPE = 2;
const MOOD_OTHERS = 0.02;
const MOOD_UNKNOWN = 0.15;
// A song's energy is its own when the model was asked (lib/musicEnergy.js). Else it is guessed by genre:
// so much is its artist's, the rest its neighbourhood's.
const ENERGY_OWN = 0.75;
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
  prepare(roots, arms, mood = "any") {
    const g = this.graph;
    const key = JSON.stringify([g.version, g.shape, this.tags ? this.tags.version : 0, g.streak, arms, mood, (roots || []).map((r) => [r.videoId, r.weight, mood === "any" ? 0 : (g.nodes.get(songId(r)) || {}).energy])]);
    if (this.state.key === key) return this.state.value;
    const streak = g.streak.length >= STREAK_LEAVE ? mean(g.streak.map((id) => [this.genreOf(g.nodes.get(id)), 1])) : null;
    const { reach } = g.rank(roots);
    const value = { reach, mood: this.moodOf(roots, mood), root: this.rootGenre(roots), streak, liked: this.tags ? this.likedGenres() : null };
    this.state = { key, value };
    return value;
  }

  energy(node) {
    if (!node) return null;
    if (Number.isFinite(node.energy)) return node.energy;
    if (!this.tags) return null;
    const around = energyOf(this.genreOf(node));
    const own = energyOf(this.tags.get(node.artist));
    return own === null || around === null ? own ?? around : ENERGY_OWN * own + (1 - ENERGY_OWN) * around;
  }

  // { mood, root } - root: what the songs are measured against.
  moodOf(roots, mood) {
    if (!(mood in MOOD_BOUNDS)) return null;
    let sum = 0;
    let weight = 0;
    for (const r of roots || []) {
      const [id] = this.graph.rootIds([r]);
      const e = id ? this.energy(this.graph.nodes.get(id)) : null;
      if (e === null) continue;
      sum += e * (r.weight > 0 ? r.weight : 1);
      weight += r.weight > 0 ? r.weight : 1;
    }
    return { mood, root: weight > 0 ? sum / weight : 0 };
  }

  fits(energy, { mood, root }) {
    if (energy === null) return false;
    const [min, max] = MOOD_BOUNDS[mood];
    return mood === "calm" ? energy <= clamp(root - MOOD_STEP, min, max) : energy >= clamp(root + MOOD_STEP, min, max);
  }

  moodFactor(energy, mood) {
    if (energy === null) return MOOD_UNKNOWN;
    const beyond = mood.mood === "calm" ? mood.root - energy : energy - mood.root;
    return this.fits(energy, mood) ? Math.exp(MOOD_SLOPE * clamp(beyond, -0.5, 0.7)) : MOOD_OTHERS;
  }

  // For MusicGraph.pick: (node) => { factor, ...notes }.
  // `fitting`: only what fits the mood.
  for(roots, { arms = {}, mood = "any", fitting = false } = {}) {
    return (node) => {
      const state = this.prepare(roots, arms, mood);
      const reach = state.reach.get(node.id) || 0;
      let factor = 1;
      const notes = { arms };
      const genre = reach >= JUDGED_REACH ? this.genreOf(node) : null;
      const sim = cosine(state.root, genre);
      if (sim !== null) notes.sim = round(sim);
      const energy = reach >= JUDGED_REACH || state.mood ? this.energy(node) : null;
      if (energy !== null) notes.energy = round(energy);
      if (state.mood) factor *= this.moodFactor(energy, state.mood);
      if (state.mood && fitting && !this.fits(energy, state.mood)) factor = 0;
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
  prefer(roots, { arms = {}, mood = "any" } = {}) {
    return (node) => {
      const state = this.prepare(roots, arms, mood);
      const genre = this.genreOf(node);
      const sim = arms.tags ? cosine(state.root, genre) : null;
      return (sim === null ? 1 : 0.7 + 0.6 * clamp(sim, 0, 1)) * (state.mood ? Math.max(0.1, this.moodFactor(this.energy(node), state.mood)) : 1);
    };
  }
}

module.exports = { MusicJudge };
