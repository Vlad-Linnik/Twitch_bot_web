// The music graph as the admin page draws it (routes/adminMusicGraph.js): the part of it worth looking
// at, with the numbers that decide what plays. Read-only; the rules are lib/musicGraph.js's.
const { NEAR, nameOf } = require("./musicGraph");

const NODES = 200;
// A song's Mix is two dozen others; the page draws a few of them, as many as its slider says.
const EDGES_PER_NODE = 24;
const EDGES = 12000;
// Beyond this a song reads as liked or disliked rather than merely played.
const MOOD = 0.2;

// One word for a node, the strongest thing to say about it first.
function stateOf(graph, node, { rootIds, currentId, waiting }) {
  if (node.id === currentId) return "playing";
  if (rootIds.has(node.id)) return "root";
  if (graph.isClosed(node.id)) return "closed";
  if (waiting.has(node.id)) return "waiting";
  const score = graph.trackScore(node.id);
  if (score < -MOOD) return "disliked";
  if (score > MOOD) return "liked";
  return graph.isHeard(node) ? "heard" : "unheard";
}

// roots: as MusicGraph.rank takes them. current, upNext: the queue's, for the states.
function describe(graph, roots, { current = null, upNext = [], songId, limit = NODES } = {}) {
  const { p, via, reach } = graph.rank(roots);
  const rootIds = new Set(graph.rootIds(roots));
  const idOf = (t) => t.node || songId(t);
  const currentId = current ? idOf(current.upNextEntry || current) : null;
  const waiting = new Set(upNext.map(idOf));
  const always = (id) => rootIds.has(id) || id === currentId || waiting.has(id);
  const ids = [...graph.nodes.keys()]
    .sort((a, b) => always(b) - always(a) || (p.get(b) || 0) - (p.get(a) || 0))
    .slice(0, limit);
  const shown = new Set(ids);
  const round = (v) => Math.round((v || 0) * 10000) / 10000;

  const nodes = ids.map((id) => {
    const node = graph.nodes.get(id);
    const rec = graph.taste.get(id) || {};
    return {
      id,
      videoId: node.videoId,
      title: node.title,
      author: node.author,
      state: stateOf(graph, node, { rootIds, currentId, waiting }),
      opened: node.expanded,
      playable: graph.playable(node),
      p: round(p.get(id)),
      reach: round(rootIds.has(id) ? 1 : reach.get(id)),
      score: round(graph.trackScore(id)),
      fresh: round(graph.freshness(id)),
      plays: rec.plays || 0,
      listens: rec.listens || 0,
      skips: rec.skips || 0,
      lastPlayedAt: rec.lastPlayedAt || null,
      via: shown.has(via.get(id)) ? via.get(id) : null,
    };
  });

  // Each node's strongest edges, `order` 0 the strongest. `main`: drawn however few are - the step a
  // song was mostly reached by, else the strongest that leads to it, so that a song with a neighbour
  // never hangs alone; and every step the channel has judged.
  const edges = [];
  const strongest = new Map();
  for (const id of ids) {
    const out = graph.edgesOf(graph.nodes.get(id)).filter(([to]) => shown.has(to));
    const weighed = out.map(([to, s]) => ({ from: id, to, similarity: round(s), taste: round(graph.edgeScore(id, to)) })).map((e) => ({ ...e, weight: round(e.similarity * Math.exp(e.taste)) }));
    weighed.sort((a, b) => b.weight - a.weight);
    for (const [order, e] of weighed.entries()) {
      const main = via.get(e.to) === id || e.taste !== 0;
      if (order >= EDGES_PER_NODE && !main) continue;
      const edge = { ...e, order, main };
      edges.push(edge);
      if (!shown.has(via.get(e.to)) && edge.weight > (strongest.get(e.to) ? strongest.get(e.to).weight : 0)) strongest.set(e.to, edge);
    }
  }
  for (const edge of strongest.values()) edge.main = true;
  edges.sort((a, b) => b.main - a.main || a.order - b.order);

  let close = 0;
  let opened = 0;
  for (const node of graph.nodes.values()) {
    if (node.expanded) opened++;
    if ((reach.get(node.id) || 0) >= NEAR) close++;
  }
  return { near: NEAR, total: graph.nodes.size, opened, close, streak: graph.streak.length, nodes, edges: edges.slice(0, EDGES) };
}

// The viewers' interest, or the donations (lib/musicInterest.js graphOf), in the same shape: a song's chance is its share of
// all who asked, and what the channel's taste says of it is only its colour.
function describeInterest(graph, { songs, links }) {
  const most = Math.max(1, ...songs.map((s) => s.askers));
  const at = new Set(songs.map((s) => s.id));
  const nodes = songs.map((s) => {
    const rec = graph.taste.get(s.id) || {};
    const score = graph.trackScore(s.id);
    return {
      id: s.id, videoId: s.videoId, title: s.title, author: s.author,
      state: graph.isClosed(s.id) ? "closed" : score < -MOOD ? "disliked" : score > MOOD ? "liked" : graph.isHeard({ id: s.id, name: nameOf(s.title, s.author) }) ? "heard" : "unheard",
      opened: true, playable: true, p: s.askers / most, reach: s.askers / most, score, fresh: 1,
      plays: rec.plays || 0, listens: rec.listens || 0, skips: rec.skips || 0, lastPlayedAt: rec.lastPlayedAt || null, via: null,
      askers: s.askers, times: s.times, askedAt: s.lastAt || null,
    };
  });
  // The strongest few of each end's, so that a much asked song is not a ball of wool.
  const used = new Map();
  const edges = links.filter((l) => at.has(l.a) && at.has(l.b)).map((l) => {
    const order = Math.min(used.get(l.a) || 0, used.get(l.b) || 0);
    for (const id of [l.a, l.b]) used.set(id, (used.get(id) || 0) + 1);
    return { from: l.a, to: l.b, weight: Math.round(l.weight * 1000) / 1000, taste: 0, order, main: order === 0 };
  });
  return { near: NEAR, total: songs.length, opened: songs.length, close: songs.length, streak: 0, nodes, edges };
}

// The same for the wire: an edge by its ends' places in `nodes`, [from, to, weight, taste, order, main]
// - a song's id is up to 120 characters, and a whole graph has thousands of edges.
function pack({ edges, ...rest }) {
  const at = new Map(rest.nodes.map((n, i) => [n.id, i]));
  return { ...rest, edges: edges.map((e) => [at.get(e.from), at.get(e.to), e.weight, e.taste, e.order, e.main ? 1 : 0]) };
}

module.exports = { describe, describeInterest, pack, NODES, EDGES };
