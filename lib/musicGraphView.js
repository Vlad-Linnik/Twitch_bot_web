// The music graph as the admin page draws it (routes/adminMusicGraph.js): the part of it worth looking
// at, with the numbers that decide what plays. Read-only; the rules are lib/musicGraph.js's.
const { NEAR } = require("./musicGraph");

const NODES = 90;
const EDGES_PER_NODE = 3;
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

  // Each node's strongest edges, and always the one it was mostly reached by.
  const edges = new Map();
  for (const id of ids) {
    const out = graph.edgesOf(graph.nodes.get(id)).filter(([to]) => shown.has(to));
    const weighed = out.map(([to, s]) => ({ from: id, to, similarity: round(s), taste: round(graph.edgeScore(id, to)) })).map((e) => ({ ...e, weight: round(e.similarity * Math.exp(e.taste)) }));
    weighed.sort((a, b) => b.weight - a.weight);
    for (const [i, e] of weighed.entries()) if (i < EDGES_PER_NODE || via.get(e.to) === id || e.taste !== 0) edges.set(`${e.from}\n${e.to}`, e);
  }

  let close = 0;
  let opened = 0;
  for (const node of graph.nodes.values()) {
    if (node.expanded) opened++;
    if ((reach.get(node.id) || 0) >= NEAR) close++;
  }
  return { near: NEAR, total: graph.nodes.size, opened, close, streak: graph.streak.length, nodes, edges: [...edges.values()] };
}

module.exports = { describe, NODES };
