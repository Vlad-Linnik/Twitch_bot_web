// /<channel>/user/<username> - charts, clouds, heatmap, mention sparkline, moderator log search.
//
// Vanilla + inline SVG, no charting library. That is a deliberate fit with this repo (zero
// client-side framework, hand-rolled modules over dependencies) and with the 2GB VPS: the whole
// file is a few KB and the server ships no extra bundle.
//
// The page boots from data the server already inlined (#dashboard-data) rather than fetching on
// load - the server just paid for those queries to render the page, and making the browser ask
// again would double the cost of every page view. Only a PERIOD CHANGE re-fetches, and only the
// component that changed.
(function () {
  "use strict";

  const dataEl = document.getElementById("dashboard-data");
  if (!dataEl) return;
  const boot = JSON.parse(dataEl.textContent);

  const $ = (id) => document.getElementById(id);
  const svgNs = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const node = document.createElementNS(svgNs, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  };

  // Per-component state, so each period toggle is independent (changing the cloud's range must
  // not reset the chart's).
  const periods = { activity: boot.period, clouds: boot.period, mentions: boot.period, logs: boot.period };

  // ---------------------------------------------------------------------------------------
  // Message-volume chart
  //
  // The spec's animation: widening the time range should COMPRESS the existing shape inward, and
  // narrowing it should STRETCH it outward. Both fall out of one trick - redraw the path with the
  // new data but keep the OLD horizontal scale, then transition scaleX to 1. More days in the
  // same width = the drawing squeezes; fewer days = it expands.
  // ---------------------------------------------------------------------------------------
  const CHART_W = 800;
  const CHART_H = 200;

  function buildPath(buckets, width, height) {
    if (buckets.length === 0) return "";
    const max = Math.max(...buckets.map((b) => b.count), 1);
    const step = buckets.length > 1 ? width / (buckets.length - 1) : 0;
    // Baseline-anchored area path, so the fill reads as volume rather than a bare line.
    let d = `M 0 ${height}`;
    buckets.forEach((b, i) => {
      const x = buckets.length === 1 ? width / 2 : i * step;
      const y = height - (b.count / max) * (height - 8) - 4;
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    d += ` L ${width} ${height} Z`;
    return d;
  }

  let prevBucketCount = (boot.activity.buckets || []).length;

  function renderChart(activity, animate) {
    const svg = $("activity-chart");
    if (!svg) return;
    const buckets = activity.buckets || [];
    const empty = svg.parentElement.querySelector("[data-empty]");

    svg.textContent = "";
    if (empty) empty.hidden = buckets.length > 0;
    if (buckets.length === 0) return;

    const group = el("g", {});
    const gradientId = "chart-fill";

    const defs = el("defs", {});
    const grad = el("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": "#a855f7", "stop-opacity": "0.5" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": "#a855f7", "stop-opacity": "0.03" }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = el("path", {
      d: buildPath(buckets, CHART_W, CHART_H),
      fill: `url(#${gradientId})`,
      stroke: "#a855f7",
      "stroke-width": "1.5",
      "vector-effect": "non-scaling-stroke",
    });
    group.appendChild(area);
    svg.appendChild(group);

    if (animate && prevBucketCount > 0 && buckets.length !== prevBucketCount) {
      // Start at the ratio the OLD data would have occupied under the new scale, then relax to 1.
      // Expanding the range (more buckets) => ratio > 1 => the shape visibly compresses inward.
      const ratio = buckets.length / prevBucketCount;
      group.style.transformOrigin = "left center";
      group.style.transform = `scaleX(${ratio})`;
      group.style.transition = "none";
      // Force a style flush so the browser treats the two transforms as distinct states rather
      // than collapsing them into one (no transition would run otherwise).
      void group.getBoundingClientRect();
      group.style.transition = "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)";
      group.style.transform = "scaleX(1)";
    }

    prevBucketCount = buckets.length;
  }

  // ---------------------------------------------------------------------------------------
  // Word / emote clouds - font size proportional to frequency.
  //
  // sqrt, not linear: a word used 50x more than another should not render 50x larger (it would
  // blow the container and drown everything else). sqrt keeps the AREA roughly proportional to
  // frequency, which is what the eye actually compares.
  // ---------------------------------------------------------------------------------------
  const MIN_FONT = 12;
  const MAX_FONT = 42;

  function renderCloud(node, items) {
    if (!node) return;
    node.textContent = "";
    if (!items || items.length === 0) return;

    const max = Math.max(...items.map((i) => i.count), 1);
    const min = Math.min(...items.map((i) => i.count));
    const span = Math.sqrt(max) - Math.sqrt(min) || 1;

    items.forEach((item, index) => {
      const scale = (Math.sqrt(item.count) - Math.sqrt(min)) / span;
      const size = MIN_FONT + scale * (MAX_FONT - MIN_FONT);

      const span_ = document.createElement("span");
      // textContent, never innerHTML - these strings come straight from chat.
      span_.textContent = item.word;
      span_.title = `${item.word} — ${item.count.toLocaleString()}`;
      span_.style.fontSize = `${size.toFixed(1)}px`;
      span_.style.lineHeight = "1.15";
      span_.className =
        "font-medium cursor-default transition-opacity " +
        (scale > 0.66 ? "text-purple-300" : scale > 0.33 ? "text-neutral-300" : "text-neutral-500");

      // Staggered fade-in so a period change reads as a change, not a flicker.
      span_.style.opacity = "0";
      span_.style.transition = "opacity 260ms ease";
      setTimeout(() => (span_.style.opacity = "1"), Math.min(index * 12, 300));

      node.appendChild(span_);
    });
  }

  function renderClouds(clouds) {
    renderCloud($("word-cloud"), clouds.words);
    renderCloud($("emote-cloud"), clouds.emotes);

    const sampled = $("cloud-sampled");
    if (sampled) sampled.hidden = !clouds.sampled;

    // An empty emote cloud is a real, explainable state (the channel has no tracked 7TV emote
    // set), not an error - say so instead of leaving a blank box.
    const emoteEmpty = $("emote-empty");
    if (emoteEmpty) emoteEmpty.hidden = (clouds.emotes || []).length > 0;
  }

  // ---------------------------------------------------------------------------------------
  // Mention sparkline
  // ---------------------------------------------------------------------------------------
  function renderMentions(mentions) {
    const total = $("mention-total");
    if (total) total.textContent = (mentions.total || 0).toLocaleString();

    const svg = $("mention-spark");
    if (!svg) return;
    svg.textContent = "";

    const daily = mentions.daily || [];
    if (daily.length < 2) return;

    const w = 400;
    const h = 48;
    const max = Math.max(...daily.map((d) => d.count), 1);
    const step = w / (daily.length - 1);
    const points = daily
      .map((d, i) => `${(i * step).toFixed(1)},${(h - (d.count / max) * (h - 6) - 3).toFixed(1)}`)
      .join(" ");

    const line = el("polyline", {
      points,
      fill: "none",
      stroke: "#a855f7",
      "stroke-width": "1.5",
      "vector-effect": "non-scaling-stroke",
      "stroke-linejoin": "round",
    });
    // Draw-on animation via stroke-dash: cheap, GPU-friendly, no JS ticking.
    svg.appendChild(line);
    const len = line.getTotalLength ? line.getTotalLength() : 0;
    if (len) {
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = String(len);
      void line.getBoundingClientRect();
      line.style.transition = "stroke-dashoffset 600ms ease-out";
      line.style.strokeDashoffset = "0";
    }
  }

  // ---------------------------------------------------------------------------------------
  // GitHub-style contribution heatmap. Always the full MAX_HEATMAP_DAYS window (the server caps
  // it), so it does not follow the period toggles - it IS the long view.
  // ---------------------------------------------------------------------------------------
  function renderHeatmap(activity) {
    const svg = $("heatmap");
    if (!svg) return;
    svg.textContent = "";

    const CELL = 12;
    const GAP = 3;
    const counts = new Map();
    for (const b of activity.buckets || []) {
      counts.set(new Date(b.date).toISOString().slice(0, 10), b.count);
    }

    const days = boot.maxHeatmapDays;
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    // Align the first column to a Sunday so weekday rows line up, like GitHub's calendar.
    start.setDate(start.getDate() - start.getDay());

    const max = Math.max(...[...counts.values()], 1);
    const shade = (count) => {
      if (!count) return "#171717"; // neutral-900: a day with no messages
      const t = Math.sqrt(count) / Math.sqrt(max); // sqrt again - linear makes everything look dim
      if (t > 0.75) return "#a855f7";
      if (t > 0.5) return "#7e3ab8";
      if (t > 0.25) return "#5b2a80";
      return "#3b1d52";
    };

    let col = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const row = cursor.getDay();
      const key = cursor.toISOString().slice(0, 10);
      const count = counts.get(key) || 0;

      const rect = el("rect", {
        x: col * (CELL + GAP),
        y: row * (CELL + GAP),
        width: CELL,
        height: CELL,
        rx: 2,
        fill: shade(count),
      });
      const title = el("title", {});
      title.textContent = `${key} — ${count.toLocaleString()}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (row === 6) col++;
      cursor.setDate(cursor.getDate() + 1);
    }

    svg.setAttribute("width", (col + 1) * (CELL + GAP));
    svg.setAttribute("height", 7 * (CELL + GAP));
  }

  // ---------------------------------------------------------------------------------------
  // Period toggles
  // ---------------------------------------------------------------------------------------
  const base = `/${encodeURIComponent(boot.channel)}/user/${encodeURIComponent(boot.username)}`;

  async function refresh(component, period) {
    periods[component] = period;

    if (component === "logs") return runSearch();

    const res = await fetch(`${base}/stats.json?component=${component}&period=${period}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();

    if (component === "activity") renderChart(data, true);
    if (component === "clouds") renderClouds(data);
    if (component === "mentions") renderMentions(data);
  }

  document.querySelectorAll("[data-period-toggle]").forEach((group) => {
    const component = group.dataset.periodToggle;
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-period]");
      if (!button) return;

      group.querySelectorAll("button").forEach((b) => {
        const active = b === button;
        b.setAttribute("aria-pressed", String(active));
        b.className =
          "px-2 py-1 text-xs rounded transition-colors " +
          (active ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300");
      });

      refresh(component, button.dataset.period);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Moderator log search - debounced, so typing does not fire a query per keystroke against a
  // rate-limited, genuinely expensive endpoint.
  // ---------------------------------------------------------------------------------------
  const searchInput = $("log-search");
  const fuzzyInput = $("log-fuzzy");
  const results = $("log-results");
  const status = $("log-status");

  let searchTimer = null;
  let searchSeq = 0;

  async function runSearch() {
    if (!results) return;

    const term = searchInput ? searchInput.value.trim() : "";
    const fuzzy = fuzzyInput && fuzzyInput.checked ? "1" : "0";
    const period = periods.logs;

    // Responses can land out of order; only the newest one may paint.
    const seq = ++searchSeq;
    status.textContent = "…";

    const url = `${base}/logs.json?q=${encodeURIComponent(term)}&period=${period}&fuzzy=${fuzzy}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (seq !== searchSeq) return;

    if (!res.ok) {
      results.textContent = "";
      status.textContent = res.status === 401 || res.status === 403 ? "⛔" : "error";
      return;
    }

    const data = await res.json();
    if (seq !== searchSeq) return;

    results.textContent = "";
    for (const row of data.results) {
      const li = document.createElement("li");
      li.className = "px-3 py-2 flex gap-3";

      const time = document.createElement("span");
      time.className = "text-neutral-600 text-xs shrink-0 tabular-nums";
      time.textContent = new Date(row.timestamp).toLocaleString();

      const msg = document.createElement("span");
      msg.className = "text-neutral-300 break-words min-w-0";
      msg.textContent = row.message; // textContent - message bodies are attacker-controlled

      li.append(time, msg);
      results.appendChild(li);
    }

    // Surface the refusal honestly rather than pretending fuzzy ran. searchRepo declines fuzzy
    // when the indexed filter has not narrowed the candidate set enough to scan it safely.
    const parts = [`${data.results.length}${data.truncated ? "+" : ""}`];
    if (data.fuzzyRefusedReason === "too_many_candidates") {
      parts.push(`fuzzy off — ${data.candidateCount.toLocaleString()} candidates, narrow the range`);
    } else if (data.fuzzyApplied) {
      parts.push("fuzzy");
    }
    status.textContent = parts.join(" · ");
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
  }
  if (fuzzyInput) fuzzyInput.addEventListener("change", runSearch);

  // ---------------------------------------------------------------------------------------
  // First paint, from the inlined server data.
  // ---------------------------------------------------------------------------------------
  renderChart(boot.activity, false);
  renderClouds(boot.clouds);
  renderMentions(boot.mentions);
  renderHeatmap(boot.activity);
  if (boot.canModerate) runSearch();
})();
