// Donation media radio: the music graph - which track to play next. Pure and in memory; the network
// and Mongo are lib/musicRadio.js's.
//
// A node is a song, a directed edge is "B goes well after A". It is a graph and not a tree: across
// the YouTube Mixes of a track and five of its neighbours, 22-56% of the songs are reached by more
// than one path, and a song several branches lead to is closer to the root than one reached once.
//
// An edge has two weights, multiplied:
//   similarity  from its place in the Mix, plus what Last.fm says when it knows the pair. The same
//               for every channel.
//   taste       what this channel did on that transition: heard to the end or skipped.
// A song has a taste of its own as well, whichever way it was reached. Taste is a log-weight that
// fades to neutral with HALF_LIFE_MS, so one bad evening does not close a branch for good.
//
// What a track is worth is a random walk with return to the root (personalised PageRank) over those
// weights: the chain the radio used before - the Mix of the last track played - had left the root by
// its second refill (1 track of 12 still near it). The walk's chance of returning grows with every
// skip in a row and shrinks while tracks are heard to the end, which is how far from the root the
// radio dares to go.
const { splitArtistTrack, leadArtist, nameKey, titleKey, parseDuration, MIN_SECONDS, MAX_SECONDS, REPEAT_AFTER_MS } = require("./donationMediaRadio");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// No track comes back sooner than REPEAT_AFTER_MS; after it, the chance grows evenly up to full over
// RETURN_MS - less for a song the channel likes, more for one it skips.
const RETURN_MS = 7 * DAY;
const RETURN_MIN_MS = 2 * DAY;
const RETURN_MAX_MS = 21 * DAY;

const HALF_LIFE_MS = 30 * DAY;
const SCORE_MIN = -3;
const SCORE_MAX = 1.5;
// A song below this is not played and not walked through until it fades back: two early skips.
const CLOSED_BELOW = -1.7;

// Being heard to the end feeds on itself: the track is worth more, so it plays more, so it is heard
// again, and with it the ones next to it - left alone, a handful of songs would praise each other up
// to playing for ever. Four things hold that down:
//   - each such hearing adds less than the last, and all of them together no more than LISTEN_CAP;
//     a person's sign (OUTCOMES.liked) is kept apart from it and comes on top, in whichever order;
//   - they raise the song and the way to it, not its neighbours, which only a sign does (see heat);
//   - every playing tires the song (TIRED), whatever its score;
//   - part of every batch is kept for songs the channel has never heard (lib/musicRadio.js).
const LISTEN_CAP = 0.7;
// A song that played n times lately is 1 / (1 + TIRED * n) as likely; a playing is half forgotten in
// TIRED_HALF_LIFE_MS.
const TIRED = 0.7;
const TIRED_HALF_LIFE_MS = 14 * DAY;

// What each outcome does to the song and to the edge it was reached by.
const OUTCOMES = {
  listened: { track: 0.45, edge: 0.45 }, // heard to the end: the channel likes it
  skipEarly: { track: -1, edge: -0.8 },
  skipMid: { track: -0.5, edge: -0.4 },
  skipLate: { track: 0, edge: 0 },
  dropped: { track: -0.3, edge: -0.2 }, // removed from the feed before it started
  liked: { track: 0.8, edge: 0.4 }, // put in the playlist, radio from it, "play now"
  through: { track: 0, edge: 0 }, // played out, but nobody can be said to have listened: seeked, muted, off air
  failed: { track: 0, edge: 0 }, // the player could not play it
  heard: { track: 0, edge: 0 }, // a donation or a request: it only counts as having played
};
const SKIP_EARLY = 0.2;
const SKIP_MID = 0.6;
const LISTENED = 0.8;
// A skip with no known length is judged by seconds.
const SKIP_EARLY_SECONDS = 40;
const SKIP_MID_SECONDS = 120;

// How much of a song's own taste its neighbours get, and the bounds of what they get in all.
const SPREAD = 0.5;
const HEAT_MIN = -1;
const HEAT_MAX = 0.6;
const HOT_LIMIT = 60;

const RESTART = 0.3;
const RESTART_MIN = 0.2;
const RESTART_MAX = 0.6;
const ITERATIONS = 25;
// Above 1 leans the choice towards the best instead of following the walk's shares exactly.
const POWER = 1.3;
// The same artist among the last few picks.
const SAME_ARTIST = 0.3;
const ARTIST_WINDOW = 3;
// From this many skips in a row on, songs near the skipped ones (the nearer, the more) and by the same
// artist are damped: the radio leaves for another branch.
const STREAK_LEAVE = 2;
const STREAK_DAMP = 0.85;

// A song whose own Mix was never asked for is joined to the songs that list it, at a fraction of
// their edge: in four cases of six nearly every neighbour's Mix led back to the root.
const REVERSE_WEIGHT = 0.5;
// How close a song is to the roots, 0..1: an edge counts in full from the root, half beyond it, over
// three steps, and several ways there add up. NEAR is what may be played as "similar to this" without
// asking the outside; a single weak path of two steps is below it, every direct neighbour above.
const STEP_SHARES = [1, 0.5, 0.5];
const NEAR = 0.25;
// Opened to find more: only songs this close, or every request would lead further from the root.
const OPEN_NEAR = 0.4;
// For new songs, when everything near is known: a little beyond the bounds.
const FRONTIER_NEAR = 0.08;

const LASTFM_WEIGHT = 0.6;
// How long a track that would not play (removed, embedding off) is left out.
const BAD_MS = 6 * HOUR;
// The same for one that failed in this channel's player, which is remembered: it passed oEmbed, so
// nothing else would keep it from being offered again (blocked in the streamer's country, say).
const FAILED_MS = 7 * DAY;
// How long a walk once computed is good for while nothing changes: taste fades and songs rest in days.
const RANK_TTL_MS = 60 * 1000;
const EXPANDED_MAX = 250;

const round = (v) => Number((v || 0).toPrecision(4));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// The song a video is: artist and title without the upload's noise, so two uploads of one song are
// one node. The words are sorted because uploaders write both "Artist - Song" and "Song - Artist".
function songId({ videoId, title, author }) {
  const parts = splitArtistTrack(title, author);
  const key = parts ? titleKey(`${parts.artist} ${parts.track}`) : "";
  const words = [...new Set(key.split(" ").filter(Boolean))].sort().join(" ").slice(0, 120);
  return words.length >= 3 ? words : `v:${videoId}`;
}

// The song's name without its artist. One band is spelt several ways ("Король и Шут", "thekorolishut",
// "Korol i Shut"), so one song may stand in the graph as several nodes; this is what keeps them from
// playing one after another. Two songs that only share a name pay for it by resting together.
function nameOf(title, author) {
  const parts = splitArtistTrack(title, author);
  return parts ? titleKey(parts.track) : titleKey(title);
}

function artistOf(title, author) {
  const parts = splitArtistTrack(title, author);
  return parts ? nameKey(leadArtist(parts.artist)) : "";
}

// status: how a queue item ended ("played" | "skipped" | "error"); progress { time, duration } in
// seconds. play { elapsed, heard }: what MediaQueue counted as really played, and as heard. live: was
// the channel on air - true, false, or null when that is not known. Returns an OUTCOMES name, or null
// for one that says nothing about the song.
//
// Music left to play says the channel likes it only when there was somebody to hear it: not off air,
// not muted, not wound forward. Pressing "skip" is a person's act and counts always.
function classify(status, progress, duration = 0, { play = null, live = null } = {}) {
  const counted = play && play.elapsed > 0 ? play : null;
  const length = progress && progress.duration > 0 ? progress.duration : duration;
  const listened = () => live !== false && (!counted || counted.heard >= LISTENED * (length || counted.elapsed));
  if (status === "played") return listened() ? "listened" : "through";
  if (status !== "skipped") return null;
  const time = counted ? counted.elapsed : progress && progress.time > 0 ? progress.time : 0;
  if (length > 0) {
    const share = time / length;
    return share < SKIP_EARLY ? "skipEarly" : share < SKIP_MID ? "skipMid" : share < LISTENED || !listened() ? "skipLate" : "listened";
  }
  return time < SKIP_EARLY_SECONDS ? "skipEarly" : time < SKIP_MID_SECONDS ? "skipMid" : "skipLate";
}

class MusicGraph {
  constructor({ now = () => Date.now(), random = Math.random } = {}) {
    this.now = now;
    this.random = random;
    this.nodes = new Map(); // id -> { id, videoId, title, author, artist, name, duration, out, links, lastfm, expanded, verified, badUntil }
    // id -> { score, at, sign, signAt, plays, tired, listens, skips, lastPlayedAt, listenedAt, failedAt,
    // videoId, title, author }. `sign`: what a person's signs add to the score.
    this.taste = new Map();
    this.names = new Map(); // nameOf -> lastPlayedAt of whichever song of that name played last
    this.edgeTaste = new Map(); // "from\nto" -> { score, at }
    this.streak = []; // ids skipped in a row, oldest first
    this.run = 0; // tracks heard to the end in a row
    this.version = 0; // of everything rank() depends on
    this.shape = 0; // of the nodes and edges alone
    this.ranked = null; // { key, at, value } - the last rank()
  }

  // A new radio: the nodes of the old one go, what the channel likes stays.
  reset() {
    this.nodes.clear();
    this.streak = [];
    this.run = 0;
    this.reshaped();
  }

  reshaped() {
    this.version++;
    this.shape++;
  }

  // --- building ----------------------------------------------------------------------------------

  // Returns the node of a track, new or known. The first upload of a song seen stays its video.
  addTrack({ videoId, title, author, duration }) {
    if (!/^[\w-]{11}$/.test(videoId || "")) return null;
    const id = songId({ videoId, title, author });
    let node = this.nodes.get(id);
    if (!node) {
      node = {
        id,
        videoId,
        title: String(title || "").slice(0, 200),
        author: String(author || "").slice(0, 100),
        artist: artistOf(title, author),
        name: nameOf(title, author),
        duration: parseDuration(duration),
        out: new Map(),
        links: new Map(),
        lastfm: new Map(),
        expanded: false,
        verified: false,
        badUntil: 0,
        energy: undefined, // -1..1; null: asked for and not known (lib/musicEnergy.js)
      };
      this.nodes.set(id, node);
      this.reshaped();
    }
    return node;
  }

  // tracks: a Mix, in its order. similar: [{ artist, track, match }] from Last.fm - it adds edges
  // only between songs the graph has, since its answer names songs, not videos.
  expand(node, tracks, similar = []) {
    node.expanded = true;
    this.reshaped();
    (tracks || []).forEach((t, i) => {
      const to = this.addTrack(t);
      if (!to || to === node) return;
      node.out.set(to.id, Math.max(node.out.get(to.id) || 0, 1 / (1 + i / 8)));
    });
    for (const s of similar || []) {
      const id = songId({ videoId: "", title: `${s.artist} - ${s.track}`, author: "" });
      if (id !== node.id && Number(s.match) > 0) node.lastfm.set(id, Math.min(1, Number(s.match)));
    }
  }

  // tracks found for a song some other way than its Mix (Last.fm, its artist), each with its `weight`.
  link(node, tracks) {
    this.reshaped();
    for (const t of tracks || []) {
      const to = this.addTrack(t);
      if (to && to !== node) node.links.set(to.id, Math.max(node.links.get(to.id) || 0, t.weight));
    }
  }

  // [[id, similarity]] - the Mix, the links and Last.fm together.
  edgesOf(node) {
    const out = new Map(node.out);
    for (const [id, s] of node.links) out.set(id, Math.max(out.get(id) || 0, s));
    for (const [id, match] of node.lastfm) out.set(id, (out.get(id) || 0) + LASTFM_WEIGHT * match);
    return [...out].filter(([id]) => this.nodes.has(id));
  }

  // [[node, similarity]] both ways around a song, the strongest first.
  neighboursOf(id, limit, { edges, incoming } = this.links()) {
    const best = new Map();
    for (const [other, s] of [...(edges.get(id) || []), ...(incoming.get(id) || [])]) if (s > (best.get(other) || 0)) best.set(other, s);
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([other, s]) => [this.nodes.get(other), s]).filter(([n]) => n);
  }

  // adjacency(), until the graph's shape changes.
  links() {
    if (!this.linked || this.linked.shape !== this.shape) this.linked = { shape: this.shape, value: this.adjacency() };
    return this.linked.value;
  }

  // Every edge, both ways: { edges: Map id -> [[to, s]], incoming: Map id -> [[from, s]] }. `edges`
  // has the reverse ones for songs not opened.
  adjacency() {
    const edges = new Map();
    const incoming = new Map();
    for (const node of this.nodes.values()) {
      const list = this.edgesOf(node);
      if (list.length > 0) edges.set(node.id, list);
      for (const [to, s] of list) {
        if (!incoming.has(to)) incoming.set(to, []);
        incoming.get(to).push([node.id, s]);
      }
    }
    for (const [id, from] of incoming) {
      if (this.nodes.get(id).expanded) continue;
      const list = edges.get(id) || [];
      const have = new Set(list.map(([to]) => to));
      edges.set(id, [...list, ...from.filter(([parent]) => !have.has(parent)).map(([parent, s]) => [parent, s * REVERSE_WEIGHT])]);
    }
    return { edges, incoming };
  }

  // Forgets what lies furthest from the roots once the graph has grown for a whole stream.
  trim(roots, max = EXPANDED_MAX) {
    const expanded = [...this.nodes.values()].filter((n) => n.expanded);
    if (expanded.length <= max) return;
    const { p } = this.rank(roots);
    this.reshaped();
    const keepRoots = new Set(this.rootIds(roots));
    expanded.sort((a, b) => (p.get(b.id) || 0) - (p.get(a.id) || 0));
    for (const node of expanded.slice(max)) {
      if (keepRoots.has(node.id)) continue;
      node.out.clear();
      node.links.clear();
      node.lastfm.clear();
      node.expanded = false;
    }
    const linked = new Set(keepRoots);
    for (const node of this.nodes.values()) if (node.expanded) for (const id of [node.id, ...node.out.keys(), ...node.links.keys()]) linked.add(id);
    for (const id of [...this.nodes.keys()]) if (!linked.has(id)) this.nodes.delete(id);
  }

  // --- taste -------------------------------------------------------------------------------------

  fade(rec) {
    return rec ? rec.score * Math.pow(0.5, Math.max(0, this.now() - rec.at) / HALF_LIFE_MS) : 0;
  }

  signOf(rec) {
    return rec && rec.sign > 0 ? rec.sign * Math.pow(0.5, Math.max(0, this.now() - rec.signAt) / HALF_LIFE_MS) : 0;
  }

  trackScore(id) {
    const rec = this.taste.get(id);
    return rec ? clamp(this.fade(rec) + this.signOf(rec), SCORE_MIN, SCORE_MAX) : 0;
  }

  edgeScore(from, to) {
    return this.fade(this.edgeTaste.get(`${from}\n${to}`));
  }

  // `score` after an outcome worth `delta`.
  moved(score, delta, outcome) {
    if (outcome !== "listened") return clamp(score + delta, SCORE_MIN, SCORE_MAX);
    if (score >= LISTEN_CAP) return score;
    return Math.min(LISTEN_CAP, score + delta * (1 - Math.max(0, score) / LISTEN_CAP));
  }

  // How many times it has played lately, fading.
  tired(rec) {
    return rec && rec.tired > 0 ? rec.tired * Math.pow(0.5, Math.max(0, this.now() - rec.lastPlayedAt) / TIRED_HALF_LIFE_MS) : 0;
  }

  isClosed(id) {
    return this.trackScore(id) < CLOSED_BELOW;
  }

  // Rows as db/musicGraphRepo.js stores them (see record).
  restoreTaste(rows) {
    this.version++;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.id !== "string" || !Number.isFinite(row.score) || !Number.isFinite(row.at)) continue;
      if (row.from) this.edgeTaste.set(`${row.from}\n${row.id}`, { score: row.score, at: row.at });
      else {
        const { id, from, ...rec } = row;
        const full = { plays: 0, listens: 0, skips: 0, lastPlayedAt: 0, listenedAt: 0, ...rec };
        this.taste.set(id, full);
        this.noteName(full);
      }
    }
  }

  noteName(rec) {
    const name = nameOf(rec.title, rec.author);
    if (name && rec.lastPlayedAt > (this.names.get(name) || 0)) this.names.set(name, rec.lastPlayedAt);
  }

  // What happened to a track. `from`: the node it was reached from (pick's `from`), if any; `feed`:
  // it came from the feed, so it may stand as a root for what comes next. Returns the changed rows,
  // ready to be stored.
  record(track, outcome, { from = null, feed = false } = {}) {
    const delta = OUTCOMES[outcome];
    if (!delta || !track || !track.videoId) return [];
    const id = track.node || songId(track);
    const now = this.now();
    this.version++;
    const rec = this.taste.get(id) || { score: 0, at: now, plays: 0, listens: 0, skips: 0, lastPlayedAt: 0, listenedAt: 0 };
    rec.score = outcome === "liked" ? this.fade(rec) : this.moved(this.fade(rec), delta.track, outcome);
    rec.at = now;
    if (outcome === "liked") {
      rec.sign = Math.min(SCORE_MAX, this.signOf(rec) + delta.track);
      rec.signAt = now;
    } else if (outcome === "skipEarly") rec.sign = 0;
    if (outcome === "failed") rec.failedAt = now;
    else if (outcome === "listened") rec.failedAt = 0;
    rec.videoId = track.videoId;
    if (track.title) rec.title = String(track.title).slice(0, 200);
    if (track.author) rec.author = String(track.author).slice(0, 100);
    if (!["liked", "dropped", "failed"].includes(outcome)) {
      rec.plays++;
      rec.tired = this.tired(rec) + 1;
      rec.lastPlayedAt = now;
    }
    if (outcome === "listened" || outcome === "through") {
      // Played out and not skipped: what comes next may grow from it either way.
      if (feed) rec.listenedAt = now;
      this.streak = [];
      if (outcome === "listened") {
        rec.listens++;
        this.run++;
      }
    } else if (outcome === "skipEarly" || outcome === "skipMid") {
      rec.skips++;
      this.streak = [...this.streak.filter((s) => s !== id), id].slice(-5);
      this.run = 0;
    }
    this.taste.set(id, rec);
    this.noteName(rec);
    const rows = [{ from: null, id, ...rec }];
    if (from && from !== id && delta.edge !== 0) {
      const key = `${from}\n${id}`;
      const edge = { score: this.moved(this.edgeScore(from, id), delta.edge, outcome), at: now };
      this.edgeTaste.set(key, edge);
      rows.push({ from, id, ...edge });
    }
    return rows;
  }

  // Feed tracks heard to the end since `since`, latest first.
  listenedSince(since, limit) {
    return [...this.taste.values()]
      .filter((r) => r.listenedAt > since && r.videoId)
      .sort((a, b) => b.listenedAt - a.listenedAt)
      .slice(0, limit)
      .map((r) => ({ videoId: r.videoId, title: r.title || "", author: r.author || "" }));
  }

  // --- the walk ----------------------------------------------------------------------------------

  // roots: [{ videoId, title, author, weight }]. Those the graph has, as ids.
  rootIds(roots) {
    return (roots || []).map((r) => songId(r)).filter((id) => this.nodes.has(id));
  }

  // Where the taste of some songs spills over: their edges both ways, and the songs that stand next
  // to them in two or more Mixes - an unexpanded song has no edges of its own to spill along.
  // Returns Map id -> added log-weight.
  heat(incoming, rootIds) {
    const hot = [...this.taste]
      .filter(([id]) => this.nodes.has(id))
      // Of what is liked, only a person's sign spills over; a skip does whole.
      .map(([id, rec]) => [id, this.trackScore(id) > 0 ? this.signOf(rec) : this.trackScore(id)])
      .filter(([, score]) => Math.abs(score) > 0.1)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, HOT_LIMIT);
    const sums = new Map();
    for (const [id, score] of hot) {
      for (const [near, closeness] of this.near(id, incoming)) sums.set(near, (sums.get(near) || 0) + SPREAD * score * closeness);
    }
    const out = new Map();
    for (const [id, sum] of sums) {
      let value = sum;
      if (value < 0) {
        // What the channel has heard to the end before, and what stands right by the root, is not
        // taken down by somebody else's skip: one skip would otherwise bury the root's own
        // neighbours.
        const rec = this.taste.get(id);
        if (rec && rec.listens > 0) value /= 1 + rec.listens;
        const toRoot = Math.max(0, ...rootIds.map((r) => (this.nodes.get(r) && this.nodes.get(r).out.get(id)) || 0));
        value *= 1 - 0.7 * toRoot;
      }
      out.set(id, clamp(value, HEAT_MIN, HEAT_MAX));
    }
    return out;
  }

  // [[id, closeness 0..1]] around a song.
  near(id, incoming) {
    const node = this.nodes.get(id);
    const rel = new Map();
    const take = (other, value) => {
      if (other !== id && value > (rel.get(other) || 0)) rel.set(other, Math.min(1, value));
    };
    if (node) for (const [to, s] of this.edgesOf(node)) take(to, s);
    const parents = incoming.get(id) || [];
    let total = 0;
    const shared = new Map();
    for (const [parent, s] of parents) {
      take(parent, s);
      total += s;
      for (const [sibling, s2] of this.edgesOf(this.nodes.get(parent))) {
        const acc = shared.get(sibling) || { sum: 0, count: 0 };
        acc.sum += Math.min(s, s2);
        acc.count++;
        shared.set(sibling, acc);
      }
    }
    for (const [sibling, acc] of shared) if (acc.count >= 2) take(sibling, acc.sum / (total + 1));
    return rel;
  }

  restartChance() {
    return clamp(RESTART + 0.12 * this.streak.length - 0.02 * Math.min(5, this.run), RESTART_MIN, RESTART_MAX);
  }

  // Returns { p, via, reach }: how often the walk visits each node, the node it mostly came from, and
  // how close it is to the roots (see NEAR) - less for what the channel skips, never more for what
  // it likes.
  rank(roots) {
    const key = JSON.stringify([this.version, this.nodes.size, this.streak, this.run, (roots || []).map((r) => [songId(r), r.weight])]);
    const now = this.now();
    if (this.ranked && this.ranked.key === key && Math.abs(now - this.ranked.at) < RANK_TTL_MS) return this.ranked.value;
    const value = this.walk(roots);
    this.ranked = { key, at: now, value };
    return value;
  }

  walk(roots) {
    const starts = new Map();
    for (const r of roots || []) {
      const id = songId(r);
      if (this.nodes.has(id)) starts.set(id, (starts.get(id) || 0) + (r.weight > 0 ? r.weight : 1));
    }
    const total = [...starts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return { p: new Map(), via: new Map(), reach: new Map() };
    for (const [id, w] of starts) starts.set(id, w / total);

    const { edges, incoming } = this.links();

    const heat = this.heat(incoming, [...starts.keys()]);
    const damp = new Map();
    if (this.streak.length >= STREAK_LEAVE) {
      for (const id of this.streak) {
        damp.set(id, 0);
        for (const [near, closeness] of this.near(id, incoming)) damp.set(near, Math.min(damp.get(near) ?? 1, 1 - STREAK_DAMP * closeness));
        const artist = this.nodes.get(id) && this.nodes.get(id).artist;
        if (artist) for (const n of this.nodes.values()) if (n.artist === artist) damp.set(n.id, Math.min(damp.get(n.id) ?? 1, 1 - STREAK_DAMP));
      }
    }
    const worth = new Map();
    const worthOf = (id) => {
      if (!worth.has(id)) worth.set(id, this.isClosed(id) ? 0 : Math.exp(this.trackScore(id) + (heat.get(id) || 0)) * (damp.get(id) ?? 1));
      return worth.get(id);
    };
    const steps = new Map();
    for (const [from, list] of edges) {
      const weighed = list.map(([to, s]) => [to, s * Math.exp(this.edgeScore(from, to)) * worthOf(to)]);
      const sum = weighed.reduce((a, [, w]) => a + w, 0);
      if (sum > 0) steps.set(from, weighed.map(([to, w]) => [to, w / sum]));
    }

    const restart = this.restartChance();
    let p = new Map(starts);
    const home = (next, amount) => {
      for (const [id, w] of starts) next.set(id, (next.get(id) || 0) + amount * w);
    };
    for (let i = 0; i < ITERATIONS; i++) {
      const next = new Map();
      home(next, restart);
      for (const [id, value] of p) {
        const list = steps.get(id);
        if (!list) home(next, value * (1 - restart));
        else for (const [to, w] of list) next.set(to, (next.get(to) || 0) + value * (1 - restart) * w);
      }
      p = next;
    }

    const via = new Map();
    const best = new Map();
    for (const [from, list] of steps) {
      const value = p.get(from) || 0;
      for (const [to, w] of list) {
        if (to === from || value * w <= (best.get(to) || 0)) continue;
        best.set(to, value * w);
        via.set(to, from);
      }
    }

    const reach = this.closeness(starts, edges);
    for (const [id, value] of reach) reach.set(id, value * Math.min(1, worthOf(id)));
    return { p, via, reach };
  }

  closeness(starts, edges) {
    const top = Math.max(...starts.values());
    let frontier = new Map([...starts].map(([id, w]) => [id, w / top]));
    const out = new Map();
    const join = (map, id, value) => map.set(id, 1 - (1 - (map.get(id) || 0)) * (1 - value));
    for (const share of STEP_SHARES) {
      const next = new Map();
      for (const [from, value] of frontier) {
        for (const [to, s] of edges.get(from) || []) if (!starts.has(to)) join(next, to, value * Math.min(1, s) * share);
      }
      for (const [id, value] of next) join(out, id, value);
      frontier = next;
    }
    return out;
  }

  // --- choosing ----------------------------------------------------------------------------------

  // 0 while a track may not come back, then rising to 1.
  freshness(id) {
    const rec = this.taste.get(id);
    const node = this.nodes.get(id);
    const last = Math.max((rec && rec.lastPlayedAt) || 0, (node && this.names.get(node.name)) || 0);
    if (!last) return 1;
    const since = this.now() - last;
    if (since < REPEAT_AFTER_MS) return 0;
    const span = clamp(RETURN_MS * Math.exp(-this.trackScore(id)), RETURN_MIN_MS, RETURN_MAX_MS);
    return clamp(since / span, 0.02, 1) / (1 + TIRED * this.tired(rec));
  }

  isHeard(node) {
    const rec = this.taste.get(node.id);
    return Boolean(rec && rec.plays > 0) || this.names.has(node.name);
  }

  playable(node) {
    const rec = this.taste.get(node.id);
    if (rec && rec.failedAt > 0 && this.now() - rec.failedAt < FAILED_MS) return false;
    return Boolean(node.title) && !(node.duration && (node.duration < MIN_SECONDS || node.duration > MAX_SECONDS)) && node.badUntil <= this.now();
  }

  // Up to `limit` tracks to play next, best and varied. `exclude` (videoIds) and `excludeKeys`
  // (titleKey()s): never these. `verified`: only tracks known to play in the OBS player.
  // `near`: only what is close to the roots. `minFresh`: the least freshness(). `unheard`: only songs the
  // channel has never heard; `heard`: only those it has. `judge`: (node, why) => { factor, ...notes } -
  // the chance is multiplied by the factor (0: out), the notes are added to `why`. `artists`
  // (latest last) and `names`: artistOf and nameOf of what plays now and waits. Each comes with `node` and `from`, which record()
  // wants back.
  pick(roots, { limit = 6, exclude = new Set(), excludeKeys = new Set(), verified = false, near = false, unheard = false, heard = false, minFresh = 0, judge = null, artists = [], names = [] } = {}) {
    const { p, via, reach } = this.rank(roots);
    const rootIds = new Set(this.rootIds(roots));
    const taken = new Set([...names, ...(roots || []).map((r) => nameOf(r.title, r.author))].filter(Boolean));
    const pool = [];
    for (const [id, value] of p) {
      const node = this.nodes.get(id);
      if (!node || rootIds.has(id) || value <= 0 || !this.playable(node) || this.isClosed(id)) continue;
      if (verified && !node.verified) continue;
      if (near && (reach.get(id) || 0) < NEAR) continue;
      if (unheard && this.isHeard(node)) continue;
      if (heard && !this.isHeard(node)) continue;
      const fresh = this.freshness(id);
      if (fresh < minFresh) continue;
      if (taken.has(node.name) || exclude.has(node.videoId) || excludeKeys.has(titleKey(node.title))) continue;
      const from = via.get(id);
      const why = { p: round(value), reach: round(reach.get(id) || 0), fresh: round(fresh), score: round(this.trackScore(id)), edge: round(from ? this.edgeScore(from, id) : 0), unheard: !this.isHeard(node) };
      const { factor = 1, ...notes } = judge ? judge(node, why) : {};
      const weight = Math.pow(value, POWER) * fresh * factor;
      if (weight > 0) pool.push({ node, weight, why: { ...why, ...notes } });
    }
    const out = [];
    const recent = artists.filter(Boolean).slice(-ARTIST_WINDOW);
    while (out.length < limit && pool.length > 0) {
      const weights = pool.map((c) => c.weight * (recent.includes(c.node.artist) ? SAME_ARTIST : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let at = this.random() * total;
      let i = 0;
      while (i < weights.length - 1 && at >= weights[i]) at -= weights[i++];
      const [{ node, why }] = pool.splice(i, 1);
      if (taken.has(node.name)) continue;
      if (node.name) taken.add(node.name);
      recent.push(node.artist);
      if (recent.length > ARTIST_WINDOW) recent.shift();
      out.push({
        videoId: node.videoId,
        title: node.title,
        author: node.author,
        duration: node.duration,
        source: "graph",
        node: node.id,
        from: via.get(node.id) || null,
        why: {
          ...why,
          sameArtist: recent.slice(0, -1).includes(node.artist),
          chance: round(weights[i] / total),
          pool: weights.length,
        },
      });
    }
    return out;
  }

  // The unopened nodes most worth opening, best first: the roots, then what is close to them
  // (OPEN_NEAR). `frontier`: for finding new songs rather than closer ones - those few opened songs
  // list, since the Mix of one that many list is mostly known. `tried`: ids not to return.
  // `prefer`: (node) => what its value is multiplied by.
  toExpand(roots, { tried = new Map(), limit = 1, frontier = false, prefer = () => 1 } = {}) {
    const open = (n) => n && !n.expanded && !tried.has(n.id);
    const out = this.rootIds(roots).map((id) => this.nodes.get(id)).filter(open);
    const { p, reach } = this.rank(roots);
    const listed = new Map();
    if (frontier) for (const n of this.nodes.values()) for (const to of n.out.keys()) listed.set(to, (listed.get(to) || 0) + 1);
    const rest = [];
    for (const [id, value] of p) {
      const node = this.nodes.get(id);
      if (!open(node) || out.includes(node) || value <= 0 || !this.playable(node) || (reach.get(id) || 0) < (frontier ? FRONTIER_NEAR : OPEN_NEAR)) continue;
      rest.push({ node, value: (frontier ? (reach.get(id) || 0) / Math.pow(listed.get(id) || 1, 2) : value) * prefer(node) });
    }
    rest.sort((a, b) => b.value - a.value);
    return [...out, ...rest.map((r) => r.node)].slice(0, limit);
  }

  // Tracks of one artist the graph knows, those heard least lately first; the ones that may not play
  // now are left out.
  byArtist(artist, { exclude = new Set(), excludeKeys = new Set(), names = [] } = {}) {
    if (!artist || artist.length < 2) return [];
    const taken = new Set(names.filter(Boolean));
    return [...this.nodes.values()]
      .filter((n) => n.artist === artist && this.playable(n) && !this.isClosed(n.id) && this.freshness(n.id) > 0)
      .filter((n) => !taken.has(n.name) && !exclude.has(n.videoId) && !excludeKeys.has(titleKey(n.title)))
      .map((n) => ({ n, weight: this.freshness(n.id) * Math.exp(this.trackScore(n.id)) * (0.5 + this.random()) }))
      .sort((a, b) => b.weight - a.weight)
      .filter(({ n }) => !taken.has(n.name) && taken.add(n.name))
      .map(({ n }) => ({ videoId: n.videoId, title: n.title, author: n.author, duration: n.duration, source: "graph", node: n.id, from: null }));
  }

  markBad(node) {
    node.verified = false;
    node.badUntil = this.now() + BAD_MS;
  }

  expandedCount() {
    let n = 0;
    for (const node of this.nodes.values()) if (node.expanded) n++;
    return n;
  }
}

module.exports = { MusicGraph, NEAR, songId, artistOf, nameOf, classify, OUTCOMES, REPEAT_AFTER_MS, HALF_LIFE_MS, RETURN_MS, CLOSED_BELOW, BAD_MS };
