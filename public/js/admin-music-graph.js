// The admin's picture of the music graph (views/adminMusicGraph.ejs, routes/adminMusicGraph.js): a live
// force-directed graph on a canvas - drag, zoom, hover a track to see what it leads to. The forces run
// in public/js/music-graph-sim.js, in a worker; here is what is shown, how it looks and what the pointer
// does. Everything on the settings panel is kept in this browser.
(function () {
  "use strict";

  const root = document.getElementById("music-graph");
  if (!root) return;
  const strings = JSON.parse(root.dataset.strings);
  const lang = root.dataset.lang || "ru";
  const t = (key) => strings[key] || key;
  const $ = (id) => document.getElementById(id);
  const stage = $("mg-stage");
  const canvas = $("mg-canvas");
  const ctx = canvas.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const REFRESH_MS = 15000;
  const NEXT_ROWS = 20;
  const STORE = "music-graph-view";
  const BG = "#1e1e1e";
  const INK = "#dadada";
  const GREY = "#b3b3b3";
  const GREY_DIM = "#7d7d7d";
  const LINK = "#565656";
  const ACCENT = "#8a5cf5";
  const LIKED_LINE = "#1a9e5c";
  const SKIPPED_LINE = "#e5484d";
  // Told apart by more than the hue: what plays and the root stand in a ring, the closed are hollow.
  const COLORS = { playing: "#f2f2f2", root: "#8a5cf5", waiting: "#2fa4dd", liked: "#1a9e5c", disliked: "#e0791a", closed: "#e5484d", heard: "#c9b458", unheard: "#8c9aa8" };
  const GROUP_COLORS = ["#d55181", "#c98500", "#3987e5", "#199e70", "#9085e9", "#e66767"];
  const GROUPS_MAX = 20;
  const DIM = 0.16;
  const K_MIN = 0.03;
  const K_MAX = 6;
  const FIT_MAX = 1.15;
  const DEPTH_ALL = 6;
  const ANIMATE_MS = 7000;

  const DEFAULTS = {
    text: "", onlyHeard: false, onlyOpened: false, closed: true, orphans: true, depth: DEPTH_ALL, perNode: 5,
    states: { playing: true, root: true, waiting: true, liked: true, disliked: true, closed: true, heard: false, unheard: false },
    groups: [],
    arrows: false, fade: 0, node: 1, line: 1, size: "links",
    center: 0.5, repel: 10, link: 1, distance: 120,
    panel: window.innerWidth > 700, open: ["filters"],
  };
  const FORCES = ["center", "repel", "link", "distance"];
  const FILTERS = ["text", "onlyHeard", "onlyOpened", "closed", "orphans", "depth", "perNode"];

  let set = readSettings();
  let data = null;
  let mode = "live"; // live | around | whole
  let query = "";
  let selected = null; // a track's id
  let timer = null;
  let request = 0;

  function readSettings() {
    const fresh = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const kept = JSON.parse(localStorage.getItem(STORE)) || {};
      for (const key of Object.keys(fresh)) if (typeof kept[key] === typeof fresh[key] && Array.isArray(kept[key]) === Array.isArray(fresh[key])) fresh[key] = kept[key];
      fresh.states = { ...DEFAULTS.states, ...fresh.states };
      fresh.groups = fresh.groups.filter((g) => g && typeof g.q === "string" && /^#[0-9a-f]{6}$/i.test(g.color)).slice(0, GROUPS_MAX);
    } catch (_) { /* a private window, or somebody else's row */ }
    fresh.text = ""; // a forgotten filter would read as an empty graph
    return fresh;
  }
  function keepSettings() {
    try {
      localStorage.setItem(STORE, JSON.stringify(set));
    } catch (_) { /* not kept, then */ }
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
  }
  const number = (v, digits) => Number(v || 0).toLocaleString(lang, { maximumFractionDigits: digits === undefined ? 0 : digits });
  const percent = (v) => `${number((v || 0) * 100)}%`;
  const signed = (v) => (v > 0 ? "+" : "") + number(v, 2);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  const nameOf = (n) => n.title || n.videoId;
  // What stands under a node: the title without what uploaders put in brackets.
  function labelOf(n) {
    const bare = nameOf(n).replace(/[([{【「].*?[)\]}】」]/g, " ").replace(/\s+/g, " ").trim();
    return short(bare || nameOf(n), 34);
  }
  const wordsOf = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);
  // Every word is there, and none of those with a minus.
  function matches(n, words) {
    const hay = `${n.title} ${n.author}`.toLowerCase();
    return words.every((w) => (w.length > 1 && w[0] === "-" ? !hay.includes(w.slice(1)) : hay.includes(w)));
  }

  // --- what is shown ---------------------------------------------------------------------------------

  // The part of `data` on the canvas, each track by a place of its own:
  //   nodes[i]   the track         r0[i] its size    color[i], hollow[i]   label[i]
  //   x[i], y[i] where it is       near[i] its neighbours    light[i] how lit it is, 0..1
  //   text[i]    how visible its label is, eased towards want[i] - what the last look at overlaps said
  //   edges      [{ a, b, weight, taste, both }]
  //   order      the places, the important first
  let view = empty();
  let gen = 0;
  const places = new Map(); // id -> [x, y], kept across reloads and filters so the picture does not jump

  function empty() {
    return { nodes: [], at: new Map(), edges: [], near: [], order: [], x: new Float32Array(0), y: new Float32Array(0), light: new Float32Array(0), text: new Float32Array(0) };
  }

  function shownEdges() {
    return data.edges.filter(([, , , , order, main]) => main || order < set.perNode);
  }

  const important = (n) => n.state === "playing" || n.state === "root";

  // Steps from the roots along what is drawn, either way; Infinity for what they do not reach.
  function hops(edges) {
    const near = data.nodes.map(() => []);
    for (const [a, b] of edges) {
      near[a].push(b);
      near[b].push(a);
    }
    const out = new Array(data.nodes.length).fill(Infinity);
    let front = [];
    data.nodes.forEach((n, i) => {
      if (n.reach < 1 && !important(n)) return;
      out[i] = 0;
      front.push(i);
    });
    for (let d = 1; front.length; d++) {
      const next = [];
      for (const i of front) {
        for (const j of near[i]) {
          if (out[j] <= d) continue;
          out[j] = d;
          next.push(j);
        }
      }
      front = next;
    }
    return out;
  }

  // The order the graph grows in from its roots.
  function growth(steps) {
    return data.nodes.map((_, i) => i).sort((a, b) => Math.min(steps[a], 1e6) - Math.min(steps[b], 1e6) || data.nodes[b].p - data.nodes[a].p);
  }

  function remember() {
    view.nodes.forEach((n, i) => {
      if (view.x[i] || view.y[i]) places.set(n.id, [view.x[i], view.y[i]]);
    });
  }

  // alpha: how much the graph stirs. reveal: { count } - only the first this many tracks by growth();
  // gets `total`.
  function rebuild({ alpha = 0.5, reveal = null } = {}) {
    remember();
    const old = view;
    const pointed = [hover, lit].map((i) => (i >= 0 && old.nodes[i] ? old.nodes[i].id : null));
    view = empty();
    if (!data) return;
    const links = shownEdges();
    const steps = hops(links);
    const words = wordsOf(set.text);
    let keep = data.nodes.map((n, i) => {
      if (words.length && !matches(n, words)) return false;
      if (set.onlyHeard && !(n.plays > 0 || important(n))) return false;
      if (set.onlyOpened && !(n.opened || important(n))) return false;
      if (!set.closed && n.state === "closed") return false;
      return set.depth >= DEPTH_ALL || steps[i] <= set.depth;
    });
    if (!set.orphans) {
      const linked = new Set();
      for (const [a, b] of links) if (keep[a] && keep[b]) linked.add(a).add(b);
      keep = keep.map((k, i) => k && (linked.has(i) || important(data.nodes[i])));
    }
    if (reveal) {
      const order = growth(steps).filter((i) => keep[i]);
      reveal.total = order.length;
      const now = new Set(order.slice(0, reveal.count));
      keep = keep.map((k, i) => k && now.has(i));
    }

    const place = new Int32Array(data.nodes.length).fill(-1);
    data.nodes.forEach((n, i) => {
      if (!keep[i]) return;
      place[i] = view.nodes.length;
      view.at.set(n.id, view.nodes.length);
      view.nodes.push(n);
    });
    const n = view.nodes.length;
    view.near = Array.from({ length: n }, () => []);
    const byPair = new Map();
    for (const [from, to, weight, taste] of links) {
      const a = place[from];
      const b = place[to];
      if (a < 0 || b < 0 || a === b) continue;
      const key = a < b ? a * n + b : b * n + a;
      const known = byPair.get(key);
      if (known) {
        known.both = known.both || known.a !== a;
        known.weight = Math.max(known.weight, weight);
        if (Math.abs(taste) > Math.abs(known.taste)) known.taste = taste;
        continue;
      }
      const edge = { a, b, weight, taste, both: false };
      byPair.set(key, edge);
      view.edges.push(edge);
      view.near[a].push(b);
      view.near[b].push(a);
    }

    view.label = view.nodes.map(labelOf);
    view.light = new Float32Array(n).fill(1);
    view.text = new Float32Array(n);
    view.want = new Uint8Array(n);
    view.labelWidth = new Float32Array(n);
    view.x = new Float32Array(n);
    view.y = new Float32Array(n);
    view.nodes.forEach((node, i) => {
      const was = old.at.get(node.id);
      if (was !== undefined) {
        view.light[i] = old.light[was];
        view.text[i] = old.text[was];
      }
      const p = places.get(node.id);
      view.x[i] = p ? p[0] : NaN;
      view.y[i] = p ? p[1] : NaN;
    });
    dress();
    const pairs = new Uint32Array(view.edges.length * 2);
    view.edges.forEach((e, i) => {
      pairs[i * 2] = e.a;
      pairs[i * 2 + 1] = e.b;
    });
    [hover, lit] = pointed.map((id) => (view.at.has(id) ? view.at.get(id) : -1));
    held = -1;
    gesture = null;
    gen++;
    sim.postMessage({ type: "graph", gen, x: view.x, y: view.y, links: pairs, alpha, settle: still.matches ? 400 : 0 });
    // Nowhere yet until the simulation has put them somewhere.
    for (let i = 0; i < n; i++) if (Number.isNaN(view.x[i])) view.x[i] = view.y[i] = 0;
    if (selected !== null && !view.at.has(selected)) select(null);
    else light();
    $("mg-counts").textContent = t("counts").replace("{{nodes}}", number(n)).replace("{{edges}}", number(view.edges.length));
  }

  // Sizes and colours, which a setting changes without moving anything.
  function dress() {
    const n = view.nodes.length;
    if (n === 0) return;
    const top = view.nodes.reduce((max, node) => (node.state === "root" ? max : Math.max(max, node.p)), 0);
    const groups = set.groups.map((g) => ({ words: wordsOf(g.q), color: g.color })).filter((g) => g.words.length);
    view.r0 = new Float32Array(n);
    view.color = [];
    view.hollow = [];
    view.nodes.forEach((node, i) => {
      let r;
      if (set.size === "chance") r = node.state === "root" ? 18 : 5 + 17 * Math.sqrt(top > 0 ? node.p / top : 0);
      else if (set.size === "close") r = 5 + 15 * node.reach;
      else r = clamp(3 * Math.sqrt(view.near[i].length + 1), 6, 30);
      view.r0[i] = r * set.node;
      const group = groups.find((g) => matches(node, g.words));
      view.color.push(group ? group.color : set.states[node.state] ? COLORS[node.state] : node.opened ? GREY : GREY_DIM);
      view.hollow.push(!group && node.state === "closed" && set.states.closed);
    });
    const rank = (node) => (node.state === "playing" ? 3 : node.state === "root" ? 2 : node.state === "waiting" ? 1 : 0);
    view.order = view.nodes.map((_, i) => i).sort((a, b) => rank(view.nodes[b]) - rank(view.nodes[a]) || view.r0[b] - view.r0[a] || view.nodes[b].p - view.nodes[a].p);
  }

  // --- the simulation ----------------------------------------------------------------------------------

  const sim = new Worker(root.dataset.sim);
  let moving = false;
  sim.onmessage = ({ data: m }) => {
    if (m.gen !== gen) return;
    for (let i = 0; i < view.nodes.length; i++) {
      if (i === held) continue; // the pointer knows better than a message on its way
      view.x[i] = m.xy[i * 2];
      view.y[i] = m.xy[i * 2 + 1];
    }
    moving = m.moving;
    if (follow) fit(false);
    draw();
  };
  function sendForces(alpha) {
    sim.postMessage({ type: "forces", forces: { center: set.center * set.center * 0.2, repel: set.repel * 45, link: set.link, distance: set.distance }, alpha });
  }

  // --- the camera --------------------------------------------------------------------------------------

  // On screen = world * k + (x, y). The camera goes towards `cam.to` a part of the way each frame.
  const cam = { x: 0, y: 0, k: 0.6, to: { x: 0, y: 0, k: 0.6 } };
  let width = 0;
  let height = 0;
  let follow = true; // keeps the whole graph in sight until the user takes over
  const pixel = () => Math.min(2, window.devicePixelRatio || 1);

  function resize() {
    const box = stage.getBoundingClientRect();
    const first = width === 0;
    for (const c of [cam, cam.to]) {
      c.x += (stage.clientWidth - width) / 2;
      c.y += (stage.clientHeight - height) / 2;
    }
    width = stage.clientWidth || box.width;
    height = stage.clientHeight || box.height;
    canvas.width = Math.round(width * pixel());
    canvas.height = Math.round(height * pixel());
    if (follow) fit(first);
    draw();
  }

  // The stage without the cards lying over it.
  function room() {
    const panel = set.panel && width > 700 ? $("mg-panel").offsetWidth + 12 : 0;
    const card = !$("mg-detail").hidden && width > 700 ? $("mg-detail").offsetWidth + 12 : 0;
    return { left: card, width: width - panel - card };
  }

  function fit(atOnce) {
    if (view.nodes.length === 0 || width === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < view.nodes.length; i++) {
      x0 = Math.min(x0, view.x[i]);
      x1 = Math.max(x1, view.x[i]);
      y0 = Math.min(y0, view.y[i]);
      y1 = Math.max(y1, view.y[i]);
    }
    const free = room();
    const k = clamp(Math.min((free.width - 120) / Math.max(1, x1 - x0), (height - 110) / Math.max(1, y1 - y0)), K_MIN, FIT_MAX);
    cam.to = { k, x: free.left + free.width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - 8 - ((y0 + y1) / 2) * k };
    if (atOnce || still.matches) Object.assign(cam, cam.to);
    draw();
  }

  function zoom(factor, px = room().left + room().width / 2, py = height / 2) {
    follow = false;
    const k = clamp(cam.to.k * factor, K_MIN, K_MAX);
    const f = k / cam.to.k;
    cam.to = { k, x: px - (px - cam.to.x) * f, y: py - (py - cam.to.y) * f };
    draw();
  }

  function flyTo(i) {
    follow = false;
    const free = room();
    const k = Math.max(cam.to.k, 0.9);
    cam.to = { k, x: free.left + free.width / 2 - view.x[i] * k, y: height / 2 - view.y[i] * k };
    draw();
  }

  function refit() {
    follow = true;
    fit(false);
  }

  // --- drawing -----------------------------------------------------------------------------------------

  let frame = 0;
  let last = 0;
  let looks = 0;
  let hover = -1;
  let held = -1;
  let focus = -1; // the track held, under the pointer, else selected: it and its neighbours are lit
  let shade = 0; // 0 everything lit, 1 only the focus
  let lit = -1; // the focus `shade` was last about, kept while it fades out

  function draw() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function light() {
    focus = held >= 0 ? held : hover >= 0 ? hover : view.at.has(selected) ? view.at.get(selected) : -1;
    if (focus >= 0) lit = focus;
    draw();
  }

  // Node sizes and texts grow slower than the distances, or zooming out would leave dust and zooming in
  // would leave discs.
  const spread = () => Math.sqrt(cam.k);
  const sx = (i) => view.x[i] * cam.k + cam.x;
  const sy = (i) => view.y[i] * cam.k + cam.y;

  function paint(now) {
    frame = 0;
    const dt = Math.min(64, now - last || 16);
    last = now;
    const ease = still.matches ? 1 : 1 - Math.exp(-dt / 70);
    let busy = false;
    const go = (from, to, eps) => {
      if (Math.abs(to - from) < eps) return to;
      busy = true;
      return from + (to - from) * ease;
    };
    cam.k = go(cam.k, cam.to.k, cam.to.k * 0.001);
    cam.x = go(cam.x, cam.to.x, 0.2);
    cam.y = go(cam.y, cam.to.y, 0.2);
    shade = go(shade, focus >= 0 ? 1 : 0, 0.01);
    const n = view.nodes.length;
    const near = lit >= 0 ? new Set(view.near[lit]).add(lit) : null;
    for (let i = 0; i < n; i++) view.light[i] = go(view.light[i], focus < 0 || near.has(i) ? 1 : DIM, 0.01);

    const scale = pixel();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    if (n > 0) {
      paintEdges();
      paintNodes();
      // While the graph moves, names chosen anew every frame would flicker.
      if (looks++ % 6 === 0 || !moving) chooseLabels(near);
      paintLabels(near, go);
    }
    if (busy) draw();
  }

  function paintEdges() {
    // A batch per look, so thousands of lines are a handful of strokes.
    const batches = new Map();
    const arrows = [];
    const grow = spread();
    for (const e of view.edges) {
      const x1 = sx(e.a);
      const y1 = sy(e.a);
      const x2 = sx(e.b);
      const y2 = sy(e.b);
      if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > width || Math.max(y1, y2) < 0 || Math.min(y1, y2) > height) continue;
      const mine = shade > 0.02 && (e.a === lit || e.b === lit);
      const judged = e.taste > 0.05 ? LIKED_LINE : e.taste < -0.05 ? SKIPPED_LINE : null;
      const thick = e.weight > 0.75 ? 1.7 : e.weight > 0.4 ? 1.35 : 1.05;
      const key = `${mine}|${judged}|${thick}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { mine, judged, thick, color: judged || (mine ? ACCENT : LINK), path: new Path2D() }));
      batch.path.moveTo(x1, y1);
      batch.path.lineTo(x2, y2);
      if (set.arrows && cam.k > 0.25) arrows.push([e, x1, y1, x2, y2, batch]);
    }
    const alphaOf = (b) => (b.mine ? 0.35 + 0.65 * shade : (b.judged ? 0.7 : 0.85) * (1 - shade * 0.8));
    for (const b of [...batches.values()].sort((p, q) => p.mine - q.mine)) {
      ctx.globalAlpha = alphaOf(b);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = Math.max(0.35, b.thick * set.line * clamp(grow, 0.6, 1.4));
      ctx.stroke(b.path);
    }
    const size = (5 + 2 * set.line) * grow;
    for (const [e, x1, y1, x2, y2, b] of arrows) {
      ctx.globalAlpha = alphaOf(b) * clamp((cam.k - 0.25) * 4, 0, 1);
      ctx.fillStyle = b.color === LINK ? "#6a6a6a" : b.color;
      arrow(x1, y1, x2, y2, view.r0[e.b] * grow, size);
      if (e.both) arrow(x2, y2, x1, y1, view.r0[e.a] * grow, size);
    }
    ctx.globalAlpha = 1;
  }

  function arrow(x1, y1, x2, y2, gap, size) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d < gap + size) return;
    const ux = (x2 - x1) / d;
    const uy = (y2 - y1) / d;
    const tx = x2 - ux * (gap + 1);
    const ty = y2 - uy * (gap + 1);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * size - uy * size * 0.45, ty - uy * size + ux * size * 0.45);
    ctx.lineTo(tx - ux * size + uy * size * 0.45, ty - uy * size - ux * size * 0.45);
    ctx.fill();
  }

  function paintNodes() {
    const grow = spread();
    for (let o = view.order.length - 1; o >= 0; o--) {
      const i = view.order[o];
      const n = view.nodes[i];
      const r = Math.max(0.8, view.r0[i] * grow);
      const x = sx(i);
      const y = sy(i);
      if (x < -r - 8 || x > width + r + 8 || y < -r - 8 || y > height + r + 8) continue;
      const on = i === lit && shade > 0.02;
      const plain = !set.states[n.state] && (view.color[i] === GREY || view.color[i] === GREY_DIM);
      ctx.globalAlpha = view.light[i] * (n.playable ? 1 : 0.5);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      if (view.hollow[i]) {
        ctx.fillStyle = BG;
        ctx.fill();
        ctx.strokeStyle = view.color[i];
        ctx.lineWidth = Math.max(1, r * 0.28);
        ctx.stroke();
      } else {
        ctx.fillStyle = on && plain && shade > 0.3 ? ACCENT : view.color[i];
        ctx.fill();
      }
      const ring = n.state === "playing" || (n.state === "root" && set.states.root);
      if (!ring && !on) continue;
      ctx.globalAlpha = on ? Math.max(ring ? 0.9 : 0, shade * 0.8) : view.light[i] * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = on ? "#e6dcff" : ACCENT;
      ctx.lineWidth = on ? 1.5 : 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const fontSize = () => Math.round(clamp(14.5 * spread(), 11, 18) * 2) / 2;
  const font = (px, strong) => `${strong ? "600 " : ""}${px}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;

  // How visible a label may be at this zoom: the bigger the node, the sooner.
  function textAlpha(i) {
    const { state } = view.nodes[i];
    const called = state === "playing" || state === "root" ? 1.5 : state === "waiting" ? 1 : 0;
    return clamp(Math.log2(cam.k) + 1.3 + called + Math.log2(view.r0[i] / set.node / 6) * 1.6 - set.fade, 0, 1);
  }

  // Which labels are shown: by importance, as long as one does not cover another.
  function chooseLabels(near) {
    const px = fontSize();
    const grow = spread();
    const CELL = 64;
    const taken = new Map();
    const cellsOf = function* (box) {
      for (let cx = Math.floor(box.l / CELL); cx <= Math.floor(box.r / CELL); cx++) {
        for (let cy = Math.floor(box.t / CELL); cy <= Math.floor(box.b / CELL); cy++) yield cx * 100003 + cy;
      }
    };
    const clashes = (box) => {
      for (const key of cellsOf(box)) if ((taken.get(key) || []).some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) return true;
      return false;
    };
    const focused = near && shade > 0.3 ? near : null;
    const order = focused ? [lit, ...view.order.filter((i) => i !== lit && focused.has(i)), ...view.order.filter((i) => !focused.has(i))] : view.order;
    view.want.fill(0);
    ctx.font = font(14);
    for (const i of order) {
      const x = sx(i);
      const y = sy(i);
      if (x < -120 || x > width + 120 || y < -20 || y > height + 20) continue;
      const called = focused && i === lit;
      if (!(focused && focused.has(i)) && textAlpha(i) <= 0.02) continue;
      if (!view.labelWidth[i]) view.labelWidth[i] = ctx.measureText(view.label[i]).width;
      const half = (view.labelWidth[i] * px) / 28 + 3;
      const top = y + view.r0[i] * grow + (called ? 10 : 4);
      const box = { l: x - half, r: x + half, t: top, b: top + px + 2 };
      if (!called && clashes(box)) continue;
      for (const key of cellsOf(box)) taken.has(key) ? taken.get(key).push(box) : taken.set(key, [box]);
      view.want[i] = 1;
    }
  }

  function paintLabels(near, go) {
    const px = fontSize();
    const grow = spread();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const write = (i, alpha, gap, halo) => {
      const x = sx(i);
      const y = sy(i) + view.r0[i] * grow + gap;
      ctx.globalAlpha = alpha;
      if (halo) {
        ctx.strokeStyle = BG;
        ctx.lineWidth = 4;
        ctx.strokeText(view.label[i], x, y);
      }
      ctx.fillStyle = INK;
      ctx.fillText(view.label[i], x, y);
    };
    ctx.font = font(px);
    for (let o = view.order.length - 1; o >= 0; o--) {
      const i = view.order[o];
      view.text[i] = go(view.text[i], view.want[i], 0.03);
      if (i === lit || view.text[i] < 0.03) continue;
      const base = near && near.has(i) ? Math.max(textAlpha(i), shade) : textAlpha(i);
      write(i, view.text[i] * base * view.light[i], 4);
    }
    // The one in focus steps down from its node a little, and is never covered.
    if (lit >= 0) {
      ctx.font = font(px + 1.5 * shade, shade > 0.6);
      write(lit, Math.max(shade, view.text[lit] * textAlpha(lit)), 4 + 6 * shade, shade > 0.3);
    }
    ctx.globalAlpha = 1;
  }

  // --- the pointer ---------------------------------------------------------------------------------------

  const pointers = new Map();
  let gesture = null; // { kind: "pan" | "node" | "pinch", ... }
  let clicked = { id: null, at: 0 };

  function under(px, py) {
    const grow = spread();
    let best = -1;
    let bestD = Infinity;
    for (const i of view.order) {
      const d = Math.hypot(sx(i) - px, sy(i) - py);
      if (d >= bestD || d >= Math.max(9, view.r0[i] * grow + 4)) continue;
      best = i;
      bestD = d;
    }
    return best;
  }
  function spot(event) {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }
  function setHover(i) {
    if (i === hover) return;
    hover = i;
    canvas.style.cursor = i >= 0 ? "pointer" : "";
    light();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const [x, y] = spot(event);
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [x, y]);
    if (pointers.size === 2) {
      drop();
      const [p, q] = [...pointers.values()];
      gesture = { kind: "pinch", d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
      return;
    }
    if (pointers.size > 2) return;
    const i = under(x, y);
    if (event.pointerType !== "touch") setHover(i);
    gesture = i >= 0 ? { kind: "node", i, x, y, moved: false, dx: sx(i) - x, dy: sy(i) - y } : { kind: "pan", x, y, moved: false };
  });
  canvas.addEventListener("pointermove", (event) => {
    const [x, y] = spot(event);
    if (!pointers.has(event.pointerId)) return setHover(event.pointerType === "touch" ? -1 : under(x, y));
    const [px, py] = pointers.get(event.pointerId);
    pointers.set(event.pointerId, [x, y]);
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      zoom(d / Math.max(1, gesture.d), (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      cam.to.x += (x - px) / 2;
      cam.to.y += (y - py) / 2;
      gesture.d = d;
      return;
    }
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < 4) return;
    gesture.moved = true;
    follow = false;
    canvas.style.cursor = "grabbing";
    if (gesture.kind === "pan") {
      for (const c of [cam, cam.to]) {
        c.x += x - px;
        c.y += y - py;
      }
      return draw();
    }
    held = gesture.i;
    view.x[held] = (x + gesture.dx - cam.x) / cam.k;
    view.y[held] = (y + gesture.dy - cam.y) / cam.k;
    sim.postMessage({ type: "hold", i: held, x: view.x[held], y: view.y[held] });
    light();
  });
  function drop() {
    if (held >= 0) sim.postMessage({ type: "release" });
    held = -1;
    gesture = null;
    canvas.style.cursor = hover >= 0 ? "pointer" : "";
  }
  function up(event) {
    if (!pointers.delete(event.pointerId)) return;
    const was = gesture;
    drop();
    // A track let go springs back from under the pointer.
    setHover(event.pointerType === "touch" || event.type !== "pointerup" ? -1 : under(...spot(event)));
    if (pointers.size === 0 && event.type === "pointerup" && was && was.kind !== "pinch" && !was.moved) {
      const node = was.kind === "node" ? view.nodes[was.i] : null;
      if (node && clicked.id === node.id && performance.now() - clicked.at < 400) return around(node);
      clicked = { id: node ? node.id : null, at: performance.now() };
      select(node ? node.id : null);
    }
    light();
  }
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => setHover(-1));
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const [x, y] = spot(event);
      if (!gesture) setHover(under(x, y));
      const lines = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      zoom(Math.exp(-clamp(lines, -240, 240) * 0.0022), x, y);
    },
    { passive: false }
  );
  canvas.addEventListener("keydown", (event) => {
    const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key];
    if (pan) {
      follow = false;
      cam.to.x += pan[0];
      cam.to.y += pan[1];
      draw();
    } else if (event.key === "+" || event.key === "=") zoom(1.3);
    else if (event.key === "-") zoom(1 / 1.3);
    else if (event.key === "0") refit();
    else if (event.key === "Escape") select(null);
    else return;
    event.preventDefault();
  });

  // --- the card of a track -------------------------------------------------------------------------------

  function select(id, go) {
    selected = id;
    drawDetail();
    light();
    if (!view.at.has(id)) return;
    const i = view.at.get(id);
    if (go) return flyTo(i);
    // The card must not cover the track it is about.
    const under = room().left + 120 - (view.x[i] * cam.to.k + cam.to.x);
    if (room().left > 0 && under > 0) {
      follow = false;
      cam.to.x += under;
    }
  }
  function around(n) {
    show("around", n.videoId);
  }

  function row(label, value) {
    return el("div", { class: "flex justify-between gap-3 py-0.5" }, el("dt", { class: "text-neutral-500" }, label), el("dd", { class: `text-neutral-200 text-right${String(value).length < 24 ? " whitespace-nowrap" : ""}` }, value));
  }

  function drawDetail() {
    const box = $("mg-detail");
    const at = selected === null || !data ? -1 : data.nodes.findIndex((x) => x.id === selected);
    box.hidden = at < 0;
    if (at < 0) return;
    const n = data.nodes[at];
    const steps = data.edges.filter((e) => e[0] === at).sort((a, b) => b[2] - a[2]).slice(0, 8);
    const via = n.via && data.nodes.find((x) => x.id === n.via);
    const link = el("a", { href: `https://www.youtube.com/watch?v=${encodeURIComponent(n.videoId)}`, target: "_blank", rel: "noopener noreferrer", class: "text-purple-300 hover:text-purple-200 underline" }, t("openTrack"));
    const aroundIt = el("button", { type: "button", class: "text-purple-300 hover:text-purple-200 underline cursor-pointer", onclick: () => around(n) }, t("around"));
    const close = el("button", { type: "button", class: "mg-icon shrink-0 -mt-1 -mr-1", "aria-label": t("closeDetail"), title: t("closeDetail"), onclick: () => select(null) }, "✕");
    box.replaceChildren(
      el("div", { class: "flex items-start justify-between gap-2" }, el("div", { class: "font-semibold text-neutral-100" }, nameOf(n)), close),
      el("div", { class: "text-neutral-500 mb-2" }, n.author || ""),
      el(
        "dl",
        {},
        row(t("closeness"), `${percent(n.reach)} · ${n.reach >= data.near ? t("close2") : t("far")}`),
        row(t("share"), `${number(n.p * 100, 1)}%`),
        row(t("taste"), `${signed(n.score)} · ${t(`state.${n.state}`)}`),
        row(t("rested"), percent(n.fresh)),
        row(t("plays"), `${n.plays} / ${n.listens} / ${n.skips}`),
        row(t("lastPlayed"), n.lastPlayedAt ? new Date(n.lastPlayedAt).toLocaleString(lang, { dateStyle: "short", timeStyle: "short" }) : t("never")),
        via ? row(t("via"), short(nameOf(via), 40)) : null
      ),
      n.opened ? "" : el("p", { class: "mt-2 text-xs text-neutral-500" }, t("notOpened")),
      n.playable ? "" : el("p", { class: "mt-2 text-xs text-amber-400" }, t("wontPlay")),
      steps.length ? el("div", { class: "mt-3 mb-1 text-neutral-500" }, t("edges")) : "",
      el(
        "div",
        { class: "mb-3 -mx-1" },
        ...steps.map(([, to, weight, taste]) =>
          el(
            "button",
            { type: "button", class: "mg-step", onclick: () => select(data.nodes[to].id, true) },
            el("span", { class: "truncate" }, nameOf(data.nodes[to])),
            el("span", { class: `shrink-0 tabular-nums ${taste > 0.05 ? "text-emerald-400" : taste < -0.05 ? "text-red-400" : "text-neutral-500"}` }, number(weight, 2))
          )
        )
      ),
      el("div", { class: "flex flex-wrap gap-x-4 gap-y-1" }, link, aroundIt)
    );
  }

  // --- the settings panel ----------------------------------------------------------------------------------

  const inputs = [...stage.querySelectorAll("[data-set]")];
  const sections = [...stage.querySelectorAll("[data-section]")];
  const OUT = {
    depth: (v) => (v >= DEPTH_ALL ? t("depthAll") : number(v)),
    perNode: (v) => number(v),
  };
  function showOut(key) {
    const out = stage.querySelector(`[data-out="${key}"]`);
    if (out && OUT[key]) out.textContent = OUT[key](set[key]);
  }
  function showSettings() {
    for (const input of inputs) {
      const value = set[input.dataset.set];
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      showOut(input.dataset.set);
    }
    for (const section of sections) section.open = set.open.includes(section.dataset.section);
    $("mg-panel").hidden = !set.panel;
    $("mg-gear").hidden = set.panel;
    drawLegend();
    drawGroups();
  }
  for (const input of inputs) {
    input.addEventListener("input", () => {
      const key = input.dataset.set;
      set[key] = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
      showOut(key);
      keepSettings();
      if (FILTERS.includes(key)) {
        stopAnimation();
        rebuild({ alpha: 0.35 });
      } else if (FORCES.includes(key)) sendForces(0.45);
      else {
        dress();
        draw();
      }
    });
  }
  for (const section of sections) {
    section.addEventListener("toggle", () => {
      set.open = sections.filter((s) => s.open).map((s) => s.dataset.section);
      keepSettings();
    });
  }
  function togglePanel(on) {
    set.panel = on;
    $("mg-panel").hidden = !on;
    $("mg-gear").hidden = on;
    keepSettings();
    (on ? $("mg-panel-close") : $("mg-gear")).focus();
    if (follow) fit(false);
  }
  $("mg-panel-close").addEventListener("click", () => togglePanel(false));
  $("mg-gear").addEventListener("click", () => togglePanel(true));
  $("mg-reset").addEventListener("click", () => {
    set = { ...JSON.parse(JSON.stringify(DEFAULTS)), open: set.open };
    keepSettings();
    showSettings();
    stopAnimation();
    sendForces(0);
    follow = true;
    rebuild({ alpha: 0.6 });
  });

  function dot(state) {
    const span = el("span", { class: "mg-dot", "aria-hidden": "true" });
    if (state === "closed") span.style.borderColor = COLORS.closed;
    else span.style.background = COLORS[state];
    if (state === "playing") span.style.boxShadow = `0 0 0 2px ${ACCENT}`;
    return span;
  }
  function redress() {
    keepSettings();
    dress();
    draw();
  }
  function drawLegend() {
    $("mg-legend").replaceChildren(
      ...Object.keys(COLORS).map((state) => {
        const box = el("input", { type: "checkbox", class: "mg-switch" });
        box.checked = set.states[state];
        box.addEventListener("change", () => {
          set.states[state] = box.checked;
          redress();
        });
        return el("label", { class: "mg-row" }, el("span", {}, dot(state), t(`state.${state}`)), box);
      })
    );
  }
  function drawGroups() {
    $("mg-groups").replaceChildren(
      ...set.groups.map((group, i) => {
        const color = el("input", { type: "color", value: group.color, "aria-label": t("groupColor"), title: t("groupColor") });
        color.addEventListener("input", () => {
          group.color = color.value;
          redress();
        });
        const words = el("input", { type: "text", class: "mg-field", maxlength: 100, value: group.q, placeholder: t("groupQuery"), "aria-label": t("groupQuery") });
        words.addEventListener("input", () => {
          group.q = words.value;
          redress();
        });
        const remove = el("button", { type: "button", class: "mg-icon", "aria-label": t("removeGroup"), title: t("removeGroup") }, "✕");
        remove.addEventListener("click", () => {
          set.groups.splice(i, 1);
          redress();
          drawGroups();
        });
        return el("div", { class: "mg-group" }, color, words, remove);
      })
    );
  }
  $("mg-new-group").addEventListener("click", () => {
    if (set.groups.length >= GROUPS_MAX) return;
    const used = set.groups.map((g) => g.color);
    set.groups.push({ q: "", color: GROUP_COLORS.find((c) => !used.includes(c)) || GROUP_COLORS[set.groups.length % GROUP_COLORS.length] });
    keepSettings();
    drawGroups();
    $("mg-groups").lastElementChild.querySelector(".mg-field").focus();
  });

  // --- the animation: the graph grows from its root ------------------------------------------------------

  let growing = null;
  function stopAnimation() {
    if (!growing) return;
    clearInterval(growing);
    growing = null;
    $("mg-animate").textContent = t("animate");
  }
  $("mg-animate").addEventListener("click", () => {
    if (growing) {
      stopAnimation();
      return rebuild({ alpha: 0.4 });
    }
    if (!data || data.nodes.length === 0) return;
    select(null);
    view = empty();
    hover = lit = -1;
    places.clear();
    follow = true;
    $("mg-animate").textContent = t("animateStop");
    const reveal = { count: 1, total: 0 };
    const started = performance.now();
    const grow = () => {
      rebuild({ alpha: 0.6, reveal });
      if (reveal.count >= reveal.total) return stopAnimation();
      // Slowly at first, while there is little to look at.
      const part = Math.min(1, (performance.now() - started) / ANIMATE_MS);
      reveal.count = Math.max(reveal.count + 1, Math.ceil(reveal.total * Math.pow(part, 1.7)));
    };
    growing = setInterval(grow, 70);
    grow();
  });

  // --- tables ------------------------------------------------------------------------------------------------

  function drawTables() {
    const card = (label, value) => el("div", { class: "rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3" }, el("dt", { class: "text-xs text-neutral-500" }, label), el("dd", { class: "text-xl font-semibold text-neutral-100" }, value));
    $("mg-totals").replaceChildren(card(t("total"), number(data.total)), card(t("opened"), number(data.opened)), card(t("close"), number(data.close)), card(t("streak"), number(data.streak)));

    const next = data.nodes.filter((n) => n.state !== "root" && n.state !== "playing" && n.state !== "closed" && n.playable && n.fresh > 0 && n.p > 0).sort((a, b) => b.p - a.p).slice(0, NEXT_ROWS);
    const pick = (n) => {
      select(n.id, true);
      stage.scrollIntoView({ block: "center", behavior: still.matches ? "auto" : "smooth" });
    };
    $("mg-next").replaceChildren(
      ...next.map((n) =>
        el(
          "tr",
          { class: "border-t border-neutral-800 hover:bg-neutral-900 cursor-pointer", onclick: () => pick(n) },
          el("td", { class: "py-1.5 pr-3 max-w-[11rem]" }, el("button", { type: "button", class: "block w-full truncate text-left cursor-pointer" }, nameOf(n))),
          el("td", { class: "py-1.5 pr-3 whitespace-nowrap" }, dot(n.state), t(`state.${n.state}`)),
          el("td", { class: "py-1.5 pr-3 text-right tabular-nums" }, percent(n.reach)),
          el("td", { class: "py-1.5 pr-3 text-right tabular-nums" }, signed(n.score)),
          el("td", { class: "py-1.5 text-right tabular-nums" }, percent(n.fresh))
        )
      )
    );

    const supply = data.stats.supply;
    const kinds = ["graph", "mix", "grow", "lastfm", "artist", "oembed"].filter((k) => supply[k]);
    $("mg-supply").replaceChildren(...(kinds.length ? kinds.map((k) => row(t(`supply.${k}`), number(supply[k]))) : [el("p", { class: "text-neutral-500" }, t("noStats"))]));
    const sources = Object.entries(data.stats.sources);
    $("mg-sources").replaceChildren(
      ...(sources.length
        ? sources.map(([name, c]) => {
            const skipped = (c.skipEarly || 0) + (c.skipMid || 0);
            const total = skipped + (c.skipLate || 0) + (c.listened || 0) + (c.through || 0);
            return row(name, t("skipShare").replace("{{skipped}}", number(skipped)).replace("{{total}}", number(total)));
          })
        : [el("p", { class: "text-neutral-500" }, t("noStats"))])
    );
    drawJournal(data.stats.journal);
  }

  const CUTS = ["closeness", "novelty", "genre", "source", "mode", "place", "hour", "asked"];
  const inOrder = (a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b);

  function drawJournal(j) {
    const share = ({ n, skips }) => (n > 0 ? `${percent(skips / n)} · ${number(n)}` : "–");
    for (const box of document.querySelectorAll("[data-arm]")) {
      const arm = j && j.arms[box.dataset.arm];
      box.textContent = arm && (arm.on.n || arm.off.n) ? `${t("armOn")} ${share(arm.on)}, ${t("armOff")} ${share(arm.off)}` : "";
    }
    const block = (title, rows) => el("div", {}, el("h3", { class: "font-semibold text-neutral-200 mb-1" }, title), el("dl", {}, ...rows));
    if (!j || Object.keys(j.outcomes).length === 0) {
      $("mg-journal").replaceChildren(el("p", { class: "text-neutral-500" }, t("journalEmpty")));
      return;
    }
    const total = [row(t("journalTotal"), share(j.total)), ...Object.entries(j.notCounted).map(([why, n]) => row(`${t("journalNotCounted")}: ${t(`reason.${why}`)}`, number(n)))];
    const cuts = CUTS.filter((c) => j.cuts[c]).map((c) =>
      block(t(`cut.${c}`), Object.keys(j.cuts[c]).sort(inOrder).map((g) => row(strings[`group.${g}`] || g, share(j.cuts[c][g]))))
    );
    $("mg-journal").replaceChildren(block(t("journalTotal"), total), ...cuts);
  }

  // --- loading -------------------------------------------------------------------------------------------------

  // What decides where things stand; a refresh that changes only numbers must not stir the graph.
  const shapeOf = (d) => JSON.stringify([d.nodes.map((n) => n.id).sort(), d.edges.map(([a, b, , , order, main]) => `${d.nodes[a].id}>${d.nodes[b].id}${main || order < set.perNode}`).sort()]);

  async function load(quiet) {
    const mine = ++request;
    clearTimeout(timer);
    if (!quiet) $("mg-status").textContent = t("loading");
    $("mg-live").setAttribute("aria-pressed", String(mode === "live"));
    $("mg-whole").setAttribute("aria-pressed", String(mode === "whole"));
    let got = null;
    try {
      const params = new URLSearchParams({ channel: $("mg-channel").value });
      if (mode === "whole") params.set("whole", "1");
      else if (mode === "around") params.set("q", query);
      const res = await fetch(`/admin/music-graph/data?${params}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      got = await res.json();
    } catch (_) {
      if (mine === request && !quiet) $("mg-status").textContent = t("failed");
    }
    if (mine !== request) return;
    // Not out of the hand that holds a track, nor from under the animation.
    if (got && !(quiet && (gesture || growing))) {
      const same = data && view.nodes.length > 0 && shapeOf(data) === shapeOf(got);
      data = got;
      $("mg-status").textContent = data.nodes.length === 0 ? t(mode === "around" ? "nothingFound" : "empty") : statusOf();
      stopAnimation();
      rebuild({ alpha: same ? 0 : quiet ? 0.25 : 1 });
      drawDetail();
      drawTables();
    }
    if (data && data.live && mode === "live" && !document.hidden) timer = setTimeout(() => load(true), REFRESH_MS);
  }
  function statusOf() {
    if (data.whole) return t("wholeStatus").replace("{{count}}", number(data.total)) + (data.cut ? t("wholeCut") : "");
    return data.root ? (data.live ? t("live") : t("stored")) + data.root : "";
  }

  function show(what, q = "") {
    mode = what;
    query = q;
    $("mg-q").value = q;
    stopAnimation();
    select(null);
    follow = true;
    load();
  }

  $("mg-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("mg-q").value.trim();
    const words = wordsOf(q);
    // In the whole graph a track is gone to where it stands; what is not there is looked for in the base.
    const known = mode === "whole" && words.length ? view.order.find((i) => view.nodes[i].videoId === q || matches(view.nodes[i], words)) : undefined;
    if (known !== undefined) select(view.nodes[known].id, true);
    else show(q ? "around" : "live", q);
  });
  $("mg-live").addEventListener("click", () => show("live"));
  $("mg-whole").addEventListener("click", () => show("whole"));
  $("mg-refresh").addEventListener("click", () => load());
  $("mg-channel").addEventListener("change", () => show(mode, query));
  $("mg-zoom-in").addEventListener("click", () => zoom(1.4));
  $("mg-zoom-out").addEventListener("click", () => zoom(1 / 1.4));
  $("mg-fit").addEventListener("click", refit);
  if (document.fullscreenEnabled) $("mg-full").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen()));
  else $("mg-full").hidden = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && data && data.live && mode === "live") load(true);
  });
  new ResizeObserver(resize).observe(stage);

  showSettings();
  resize();
  sendForces(0);
  load();
})();
