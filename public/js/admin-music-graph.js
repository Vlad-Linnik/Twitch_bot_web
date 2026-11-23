// The admin's picture of the music graph (views/adminMusicGraph.ejs, routes/adminMusicGraph.js). The
// distance from the centre is data - how close a track is to what the choice starts from - so the
// layout holds every node to its own radius and only finds it a place around the circle.
(function () {
  "use strict";

  const root = document.getElementById("music-graph");
  if (!root) return;
  const strings = JSON.parse(root.dataset.strings);
  const lang = root.dataset.lang || "ru";
  const t = (key) => strings[key] || key;
  const $ = (id) => document.getElementById(id);
  const svg = $("mg-svg");
  const SVG = "http://www.w3.org/2000/svg";
  const REFRESH_MS = 15000;
  const LABELS = 22;
  const NEXT_ROWS = 20;
  const R_ROOT = 26;
  const R_CLOSEST = 90;
  const R_NEAR = 310;
  const R_FAR = 430;

  const COLORS = {
    root: "#c084fc", playing: "#f0abfc", waiting: "#38bdf8", liked: "#34d399",
    disliked: "#fb923c", closed: "#ef4444", heard: "#a3a3a3", unheard: "#64748b",
  };

  let data = null;
  let query = "";
  let selected = null;
  let timer = null;
  let request = 0;
  const places = new Map(); // id -> { x, y }, kept across refreshes so the picture does not jump

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
  function shape(tag, attrs) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }
  const number = (v, digits) => Number(v || 0).toLocaleString(lang, { maximumFractionDigits: digits === undefined ? 0 : digits });
  const percent = (v) => `${number((v || 0) * 100)}%`;
  const signed = (v) => (v > 0 ? "+" : "") + number(v, 2);
  const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const nameOf = (n) => n.title || n.videoId;

  // --- layout --------------------------------------------------------------------------------------

  function radiusOf(n, rootCount) {
    if (n.state === "root" || n.reach >= 1) return rootCount > 1 ? R_ROOT : 0;
    const near = data.near;
    // The root of the distance: most of the close ones are very close, and would pile up in the middle.
    if (n.reach >= near) return R_CLOSEST + Math.sqrt((1 - n.reach) / (1 - near)) * (R_NEAR - R_CLOSEST - 12);
    return R_NEAR + 14 + (1 - n.reach / near) * (R_FAR - R_NEAR - 14);
  }

  const sizeOf = (n, top) => (n.state === "root" ? 13 : 4.5 + 10 * Math.sqrt(top > 0 ? n.p / top : 0));

  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  }

  function layout(nodes, edges) {
    const roots = nodes.filter((n) => n.state === "root").length;
    const items = nodes.map((n) => {
      const r = radiusOf(n, roots);
      const known = places.get(n.id);
      const angle = known && (known.x || known.y) ? Math.atan2(known.y, known.x) : hash(n.id) * 2 * Math.PI;
      return { n, r, x: r * Math.cos(angle), y: r * Math.sin(angle), dx: 0, dy: 0 };
    });
    const byId = new Map(items.map((i) => [i.n.id, i]));
    const springs = edges.map((e) => [byId.get(e.from), byId.get(e.to), Math.min(1.2, e.weight)]);
    const steps = 260;
    for (let step = 0; step < steps; step++) {
      const cool = 1 - step / steps;
      for (const i of items) i.dx = i.dy = 0;
      for (let a = 0; a < items.length; a++) {
        for (let b = a + 1; b < items.length; b++) {
          const p = items[a];
          const q = items[b];
          const x = p.x - q.x || 0.01;
          const y = p.y - q.y || 0.01;
          const push = 2600 / (x * x + y * y + 60);
          const d = Math.sqrt(x * x + y * y);
          p.dx += (x / d) * push;
          p.dy += (y / d) * push;
          q.dx -= (x / d) * push;
          q.dy -= (y / d) * push;
        }
      }
      for (const [p, q, w] of springs) {
        const x = q.x - p.x;
        const y = q.y - p.y;
        p.dx += x * 0.008 * w;
        p.dy += y * 0.008 * w;
        q.dx -= x * 0.008 * w;
        q.dy -= y * 0.008 * w;
      }
      for (const i of items) {
        i.x += i.dx * cool;
        i.y += i.dy * cool;
        const d = Math.sqrt(i.x * i.x + i.y * i.y) || 0.01;
        i.x *= i.r / d;
        i.y *= i.r / d;
      }
    }
    places.clear();
    for (const i of items) places.set(i.n.id, { x: i.x, y: i.y });
  }

  // --- drawing -------------------------------------------------------------------------------------

  function draw() {
    svg.replaceChildren();
    const { nodes, edges } = data;
    if (nodes.length === 0) return;
    layout(nodes, edges);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const top = Math.max(...nodes.filter((n) => n.state !== "root").map((n) => n.p), 0);

    svg.append(shape("circle", { cx: 0, cy: 0, r: R_NEAR, fill: "none", stroke: "#404040", "stroke-dasharray": "4 6" }));
    for (const [text, y] of [[t("close2"), -R_NEAR + 16], [t("far"), -R_NEAR - 8]]) {
      const label = shape("text", { x: 0, y, "text-anchor": "middle", "font-size": 12, fill: "#737373" });
      label.textContent = text;
      svg.append(label);
    }

    const lines = shape("g", {});
    for (const e of edges) {
      const a = places.get(e.from);
      const b = places.get(e.to);
      const color = e.taste > 0.05 ? "#34d399" : e.taste < -0.05 ? "#ef4444" : "#525252";
      const line = shape("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color, "stroke-width": Math.min(4, 0.4 + e.weight * 1.8).toFixed(2), "stroke-opacity": e.taste !== 0 ? 0.75 : 0.28 });
      line.dataset.from = e.from;
      line.dataset.to = e.to;
      lines.append(line);
    }
    svg.append(lines);

    const labelled = labels(nodes, top);
    const group = shape("g", {});
    for (const n of nodes) {
      const { x, y } = places.get(n.id);
      const r = sizeOf(n, top);
      const g = shape("g", { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, tabindex: 0, role: "button", "aria-label": `${nameOf(n)}, ${t(`state.${n.state}`)}` });
      g.style.cursor = "pointer";
      g.style.outlineOffset = "3px";
      g.dataset.id = n.id;
      g.append(shape("circle", { r: r.toFixed(1), fill: n.opened ? COLORS[n.state] : "#0a0a0a", stroke: COLORS[n.state], "stroke-width": n.opened ? 1 : 2, "stroke-opacity": n.playable ? 1 : 0.4, "fill-opacity": n.playable ? 1 : 0.4 }));
      const title = shape("title", {});
      title.textContent = `${nameOf(n)} · ${t(`state.${n.state}`)}`;
      g.append(title);
      if (labelled.has(n.id)) {
        const right = toTheRight(x);
        const label = shape("text", { x: right ? r + 4 : -r - 4, y: 4, "font-size": 12, fill: "#d4d4d4", "text-anchor": right ? "start" : "end", "paint-order": "stroke", stroke: "#0a0a0a", "stroke-width": 3 });
        label.textContent = short(nameOf(n), 26);
        g.append(label);
      }
      g.addEventListener("click", () => select(n.id));
      g.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select(n.id);
      });
      group.append(g);
    }
    svg.append(group);
    if (selected && !byId.has(selected)) selected = null;
    highlight();
  }

  const toTheRight = (x) => x < 250;

  // Which tracks are named: what plays and waits, then the likeliest, as long as a name does not cover
  // another.
  function labels(nodes, top) {
    const rank = (n) => (n.state === "playing" ? 3 : n.state === "root" ? 2 : n.state === "waiting" ? 1 : 0);
    const boxes = [];
    const out = new Set();
    for (const n of [...nodes].sort((a, b) => rank(b) - rank(a) || b.p - a.p)) {
      if (out.size >= LABELS) break;
      const { x, y } = places.get(n.id);
      const width = Math.min(26, nameOf(n).length) * 6.6;
      const left = toTheRight(x) ? x + sizeOf(n, top) : x - sizeOf(n, top) - width;
      const box = { left, right: left + width + 8, top: y - 8, bottom: y + 8 };
      if (boxes.some((b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top)) continue;
      boxes.push(box);
      out.add(n.id);
    }
    return out;
  }

  // The selected track, what it leads to and what leads to it; the rest steps back.
  function highlight() {
    const linked = new Set([selected]);
    for (const line of svg.querySelectorAll("line")) {
      const on = !selected || line.dataset.from === selected || line.dataset.to === selected;
      if (selected && on) linked.add(line.dataset.from).add(line.dataset.to);
      line.style.opacity = on ? "" : "0.12";
    }
    for (const g of svg.querySelectorAll("g[data-id]")) g.style.opacity = !selected || linked.has(g.dataset.id) ? "" : "0.2";
  }

  function select(id) {
    selected = selected === id ? null : id;
    highlight();
    drawDetail();
  }

  function row(label, value) {
    return el("div", { class: "flex justify-between gap-3 py-0.5" }, el("dt", { class: "text-neutral-500" }, label), el("dd", { class: `text-neutral-200 text-right${String(value).length < 24 ? " whitespace-nowrap" : ""}` }, value));
  }

  function drawDetail() {
    const box = $("mg-detail");
    const n = selected && data.nodes.find((x) => x.id === selected);
    if (!n) {
      if (!box.dataset.hint) box.dataset.hint = box.textContent;
      box.replaceChildren(box.dataset.hint);
      return;
    }
    if (!box.dataset.hint) box.dataset.hint = box.textContent;
    const byId = new Map(data.nodes.map((x) => [x.id, x]));
    const steps = data.edges.filter((e) => e.from === n.id).sort((a, b) => b.weight - a.weight).slice(0, 8);
    const link = el("a", { href: `https://www.youtube.com/watch?v=${encodeURIComponent(n.videoId)}`, target: "_blank", rel: "noopener noreferrer", class: "text-purple-300 hover:text-purple-200 underline" }, t("openTrack"));
    const around = el("button", { type: "button", class: "text-purple-300 hover:text-purple-200 underline", onclick: () => show(n.videoId) }, t("around"));
    box.replaceChildren(
      el("div", { class: "font-semibold text-neutral-100" }, nameOf(n)),
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
        n.via && byId.has(n.via) ? row(t("via"), short(nameOf(byId.get(n.via)), 40)) : null
      ),
      n.opened ? "" : el("p", { class: "mt-2 text-xs text-neutral-500" }, t("notOpened")),
      n.playable ? "" : el("p", { class: "mt-2 text-xs text-amber-400" }, t("wontPlay")),
      steps.length ? el("div", { class: "mt-3 mb-1 text-neutral-500" }, t("edges")) : "",
      el("ul", { class: "space-y-0.5 mb-3" }, ...steps.map((e) => el("li", { class: "flex justify-between gap-2" }, el("span", { class: "truncate" }, nameOf(byId.get(e.to))), el("span", { class: e.taste > 0.05 ? "text-emerald-400" : e.taste < -0.05 ? "text-red-400" : "text-neutral-500" }, number(e.weight, 2))))),
      el("div", { class: "flex flex-wrap gap-x-4 gap-y-1" }, link, around)
    );
  }

  function drawTables() {
    const card = (label, value) => el("div", { class: "rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3" }, el("dt", { class: "text-xs text-neutral-500" }, label), el("dd", { class: "text-xl font-semibold text-neutral-100" }, value));
    $("mg-totals").replaceChildren(card(t("total"), number(data.total)), card(t("opened"), number(data.opened)), card(t("close"), number(data.close)), card(t("streak"), number(data.streak)));

    const next = data.nodes.filter((n) => n.state !== "root" && n.state !== "playing" && n.state !== "closed" && n.playable && n.fresh > 0).sort((a, b) => b.p - a.p).slice(0, NEXT_ROWS);
    $("mg-next").replaceChildren(
      ...next.map((n) =>
        el(
          "tr",
          { class: "border-t border-neutral-800 hover:bg-neutral-900 cursor-pointer", onclick: () => select(n.id) },
          el("td", { class: "py-1.5 pr-3 max-w-[11rem] truncate" }, nameOf(n)),
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
            const total = skipped + (c.skipLate || 0) + (c.listened || 0);
            return row(name, t("skipShare").replace("{{skipped}}", number(skipped)).replace("{{total}}", number(total)));
          })
        : [el("p", { class: "text-neutral-500" }, t("noStats"))])
    );
  }

  function dot(state) {
    const span = el("span", { class: "inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle", "aria-hidden": "true" });
    span.style.background = COLORS[state];
    return span;
  }

  // --- loading -------------------------------------------------------------------------------------

  async function load(quiet) {
    const mine = ++request;
    clearTimeout(timer);
    if (!quiet) $("mg-status").textContent = t("loading");
    let got = null;
    try {
      const params = new URLSearchParams({ channel: $("mg-channel").value });
      if (query) params.set("q", query);
      const res = await fetch(`/admin/music-graph/data?${params}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      got = await res.json();
    } catch (_) {
      if (mine === request && !quiet) $("mg-status").textContent = t("failed");
    }
    if (mine !== request) return;
    if (got) {
      data = got;
      const where = data.root ? (data.live ? t("live") : t("stored")) + data.root : "";
      $("mg-status").textContent = data.nodes.length ? where : query ? t("nothingFound") : t("empty");
      draw();
      drawDetail();
      drawTables();
    }
    if (data && data.live && !document.hidden) timer = setTimeout(() => load(true), REFRESH_MS);
  }

  function show(q) {
    query = q;
    $("mg-q").value = q;
    selected = null;
    places.clear();
    load();
  }

  $("mg-legend").replaceChildren(...Object.keys(COLORS).map((state) => el("li", {}, dot(state), t(`state.${state}`))));
  $("mg-form").addEventListener("submit", (event) => {
    event.preventDefault();
    show($("mg-q").value.trim());
  });
  $("mg-live").addEventListener("click", () => show(""));
  $("mg-refresh").addEventListener("click", () => load());
  $("mg-channel").addEventListener("change", () => show(query));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && data && data.live) load(true);
  });
  load();
})();
