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
  // Axis helpers, shared by the volume chart and the mention chart.
  //
  // Labels are HTML (the .ejs provides a Y gutter column and an X row per chart), never SVG
  // <text>: both charts stretch with preserveAspectRatio="none", which would distort glyphs.
  // The SVG only ever carries geometry (paths, bars, gridlines).
  // ---------------------------------------------------------------------------------------
  const numCompact = new Intl.NumberFormat(boot.locale, { notation: "compact", maximumFractionDigits: 1 });
  const numFull = new Intl.NumberFormat(boot.locale);
  const timeFmt = new Intl.DateTimeFormat(boot.locale, { hour: "2-digit", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(boot.locale, { day: "numeric", month: "short" });
  const dateFullFmt = new Intl.DateTimeFormat(boot.locale, { dateStyle: "medium" });

  // Hour-or-finer buckets are labelled as times; anything coarser as dates.
  const tickLabel = (bucket, bucketMs) =>
    (bucketMs && bucketMs <= 3600000 ? timeFmt : dayFmt).format(new Date(bucket.date));

  // Evenly spaced tick indices, first and last always included. The X rows are justify-between
  // flex containers, which spreads the labels to visually match these positions.
  function tickIndices(n, want) {
    const count = Math.min(want, n);
    if (count <= 1) return n ? [0] : [];
    const idx = [];
    for (let i = 0; i < count; i++) idx.push(Math.round((i * (n - 1)) / (count - 1)));
    return [...new Set(idx)];
  }

  function fillAxes(yAxisEl, xAxisEl, buckets, max, bucketMs, wantTicks) {
    if (yAxisEl) {
      yAxisEl.textContent = "";
      for (const value of [max, max / 2, 0]) {
        const span = document.createElement("span");
        span.textContent = numCompact.format(Math.round(value));
        yAxisEl.appendChild(span);
      }
    }
    if (xAxisEl) {
      xAxisEl.textContent = "";
      for (const i of tickIndices(buckets.length, wantTicks)) {
        const span = document.createElement("span");
        span.textContent = tickLabel(buckets[i], bucketMs);
        xAxisEl.appendChild(span);
      }
    }
  }

  function clearAxes(yAxisEl, xAxisEl) {
    if (yAxisEl) yAxisEl.textContent = "";
    if (xAxisEl) xAxisEl.textContent = "";
  }

  // value -> y mapping shared by paths, bars and gridlines: 0 sits PLOT_PAD above the bottom
  // edge, max sits PLOT_PAD below the top edge, so the max/mid/0 gridlines line up with the
  // justify-between Y-label column (its py-0.5 approximates the same inset).
  const PLOT_PAD = 4;
  const yFor = (value, max, height) => height - PLOT_PAD - (value / max) * (height - 2 * PLOT_PAD);

  function drawGridlines(svg, width, height) {
    for (const y of [PLOT_PAD, height / 2, height - PLOT_PAD]) {
      svg.appendChild(
        el("line", {
          x1: 0,
          y1: y,
          x2: width,
          y2: y,
          stroke: "#262626",
          "stroke-width": "1",
          "vector-effect": "non-scaling-stroke",
        })
      );
    }
  }

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
      const y = yFor(b.count, max, height);
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    d += ` L ${width} ${height} Z`;
    return d;
  }

  // boot.activity is null when the profile owner hides the message-volume chart - this runs at
  // module top level, so without the ?. one hidden section used to throw here and take the
  // whole page's rendering (clouds, heatmap, period toggles) down with it.
  let prevBucketCount = (boot.activity?.buckets || []).length;

  function renderChart(activity, animate) {
    const svg = $("activity-chart");
    if (!svg) return;
    const buckets = activity.buckets || [];
    const yAxis = $("activity-yaxis");
    const xAxis = $("activity-xaxis");
    const empty = svg.closest("[data-component]").querySelector("[data-empty]");

    svg.textContent = "";
    // The series is zero-filled server-side, so "no buckets" never happens - "all zeros" is the
    // real empty state now.
    const hasData = buckets.some((b) => b.count > 0);
    if (empty) empty.hidden = hasData;
    if (!hasData) {
      clearAxes(yAxis, xAxis);
      return;
    }

    const max = Math.max(...buckets.map((b) => b.count), 1);
    fillAxes(yAxis, xAxis, buckets, max, activity.bucketMs, 5);
    drawGridlines(svg, CHART_W, CHART_H);

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
  // frequency, which is what the eye actually compares. Placement is CloudLayout's center-out
  // spiral (cloud-layout.js), same as the channel statistics page.
  // ---------------------------------------------------------------------------------------
  const MIN_FONT = 12;
  const MAX_FONT = 42;

  function renderCloud(node, items) {
    if (!node) return;

    const list = items || [];
    const max = Math.max(...list.map((i) => i.count), 1);
    const min = list.length ? Math.min(...list.map((i) => i.count)) : 0;
    const span = Math.sqrt(max) - Math.sqrt(min) || 1;

    CloudLayout.render(node, list, (item) => {
      const scale = (Math.sqrt(item.count) - Math.sqrt(min)) / span;
      const size = MIN_FONT + scale * (MAX_FONT - MIN_FONT);

      const span_ = document.createElement("span");
      // textContent, never innerHTML - these strings come straight from chat.
      span_.textContent = item.word;
      span_.title = `${item.word} — ${item.count.toLocaleString()}`;
      span_.style.fontSize = `${size.toFixed(1)}px`;
      span_.style.lineHeight = "1.15";
      span_.className =
        "font-medium cursor-default " +
        (scale > 0.66 ? "text-purple-300" : scale > 0.33 ? "text-neutral-300" : "text-neutral-500");
      return span_;
    });
  }

  // Emote cloud - real emote images (the server joins imageUrl from the channel's 7TV set +
  // Twitch globals, same as the statistics page). Sized for this page's narrower half-width
  // column - the statistics page's 96px top end would drown a min-h-40 card. An emote with no
  // image (removed from the set since it was counted) keeps its text form.
  const EMOTE_MIN = 16;
  const EMOTE_MAX = 56;

  function renderEmoteCloud(node, items) {
    if (!node) return;

    const list = items || [];
    const max = Math.max(...list.map((i) => i.count), 1);
    const min = list.length ? Math.min(...list.map((i) => i.count)) : 0;
    const span = Math.sqrt(max) - Math.sqrt(min) || 1;

    CloudLayout.render(node, list, (item) => {
      const scale = (Math.sqrt(item.count) - Math.sqrt(min)) / span;
      const size = Math.round(EMOTE_MIN + scale * (EMOTE_MAX - EMOTE_MIN));
      const title = `${item.word} — ${item.count.toLocaleString()}`;

      if (item.imageUrl) {
        // No loading="lazy": CloudLayout must know every image's width up front to place it
        // (it awaits img.decode()), so deferring the fetch would only delay the whole cloud.
        const img = document.createElement("img");
        img.src = item.imageUrl;
        img.alt = item.word;
        img.title = title;
        img.style.height = `${size}px`;
        img.className = "w-auto hover:scale-110 transition-transform";
        return img;
      }
      const text = document.createElement("span");
      text.textContent = item.word; // chat-derived - textContent only
      text.title = title;
      text.style.fontSize = `${Math.max(12, Math.round(size * 0.45))}px`;
      text.className = "text-neutral-400 font-medium";
      return text;
    });
  }

  function renderClouds(clouds) {
    renderCloud($("word-cloud"), clouds.words);
    renderEmoteCloud($("emote-cloud"), clouds.emotes);

    const sampled = $("cloud-sampled");
    if (sampled) sampled.hidden = !clouds.sampled;

    // An empty emote cloud is a real, explainable state (the channel has no tracked 7TV emote
    // set), not an error - say so instead of leaving a blank box.
    const emoteEmpty = $("emote-empty");
    if (emoteEmpty) emoteEmpty.hidden = (clouds.emotes || []).length > 0;
  }

  // ---------------------------------------------------------------------------------------
  // Mention chart. Bars, not a line: mention data only exists at day granularity (the bot's
  // daily rollup), so short periods have honestly few points - 2 bars for "day" - and a line
  // through 2 points reads as a trend that is not there. Bars degrade gracefully to any count.
  // The headline total follows the period toggle (the server scopes it).
  // ---------------------------------------------------------------------------------------
  function renderMentions(mentions) {
    const total = $("mention-total");
    if (total) total.textContent = numFull.format(mentions.total || 0);

    const svg = $("mention-spark");
    if (!svg) return;
    svg.textContent = "";

    const yAxis = $("mention-yaxis");
    const xAxis = $("mention-xaxis");
    const daily = mentions.daily || [];
    if (daily.length === 0) {
      clearAxes(yAxis, xAxis);
      return;
    }

    const w = 400;
    const h = 96;
    const max = Math.max(...daily.map((d) => d.count), 1);

    fillAxes(yAxis, xAxis, daily, max, 86400000, 4);
    drawGridlines(svg, w, h);

    const slot = w / daily.length;
    const barW = Math.max(slot * 0.65, 1);
    const group = el("g", {});
    daily.forEach((d, i) => {
      const y = yFor(d.count, max, h);
      const barH = h - PLOT_PAD - y;
      if (barH <= 0) return; // zero days stay empty; the gridline already marks the baseline
      const rect = el("rect", {
        x: (i * slot + (slot - barW) / 2).toFixed(1),
        y: y.toFixed(1),
        width: barW.toFixed(1),
        height: barH.toFixed(1),
        fill: "#a855f7",
        "fill-opacity": "0.75",
      });
      const title = el("title", {});
      title.textContent = `${dayFmt.format(new Date(d.date))} — ${numFull.format(d.count)}`;
      rect.appendChild(title);
      group.appendChild(rect);
    });
    svg.appendChild(group);

    // Grow-from-baseline animation, same flush trick as the volume chart's scaleX.
    group.style.transformOrigin = `center ${h - PLOT_PAD}px`;
    group.style.transform = "scaleY(0)";
    group.style.transition = "none";
    void group.getBoundingClientRect();
    group.style.transition = "transform 420ms cubic-bezier(0.22, 1, 0.36, 1)";
    group.style.transform = "scaleY(1)";
  }

  // ---------------------------------------------------------------------------------------
  // GitHub-style contribution heatmap. Always the full MAX_HEATMAP_DAYS window (the server caps
  // it), so it does not follow the period toggles - it IS the long view.
  //
  // Months run along the top (X), weekdays down the left (Y), like GitHub's calendar. Labels
  // here ARE SVG <text> - unlike the charts, this SVG gets explicit pixel width/height (no
  // stretching), so text renders undistorted. The color-ramp legend lives in the .ejs; keep
  // its swatches in sync with shade() below.
  // ---------------------------------------------------------------------------------------
  function renderHeatmap(heatmap) {
    const svg = $("heatmap");
    if (!svg) return;
    svg.textContent = "";

    const CELL = 15;
    const GAP = 4;
    const PITCH = CELL + GAP;
    const LEFT = 34; // weekday-label gutter
    const TOP = 18; // month-label row

    const counts = new Map();
    for (const b of heatmap.buckets || []) {
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

    const label = (x, y, text, anchor) => {
      const node = el("text", { x, y, fill: "#737373", "font-size": "10", "text-anchor": anchor });
      node.textContent = text;
      svg.appendChild(node);
    };

    const monthFmt = new Intl.DateTimeFormat(boot.locale, { month: "short" });
    const weekdayFmt = new Intl.DateTimeFormat(boot.locale, { weekday: "short" });

    // Mon / Wed / Fri rows, GitHub-style. `start` is Sunday-aligned, so start+row lands on the
    // weekday of row N regardless of locale.
    for (const row of [1, 3, 5]) {
      const d = new Date(start);
      d.setDate(d.getDate() + row);
      label(LEFT - 6, TOP + row * PITCH + CELL - 4, weekdayFmt.format(d), "end");
    }

    let col = 0;
    let prevColMonth = null;
    const cursor = new Date(start);
    while (cursor <= end) {
      const row = cursor.getDay();

      if (row === 0) {
        // Label a column when the month turned over since the previous column. The first
        // column is only labelled if it actually starts the month (day <= 7) - a leading
        // partial month would otherwise put two labels a column apart.
        const month = cursor.getMonth();
        const turned = prevColMonth === null ? cursor.getDate() <= 7 : month !== prevColMonth;
        if (turned) label(LEFT + col * PITCH, TOP - 7, monthFmt.format(cursor), "start");
        prevColMonth = month;
      }

      const key = cursor.toISOString().slice(0, 10);
      const count = counts.get(key) || 0;

      const rect = el("rect", {
        x: LEFT + col * PITCH,
        y: TOP + row * PITCH,
        width: CELL,
        height: CELL,
        rx: 3,
        fill: shade(count),
      });
      const title = el("title", {});
      title.textContent = `${dateFullFmt.format(cursor)} — ${numFull.format(count)}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (row === 6) col++;
      cursor.setDate(cursor.getDate() + 1);
    }

    svg.setAttribute("width", LEFT + (col + 1) * PITCH);
    svg.setAttribute("height", TOP + 7 * PITCH);
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
  // First paint, from the inlined server data. activity/heatmap arrive as null when the
  // profile owner hides them (the server omits both the data and the section markup).
  // ---------------------------------------------------------------------------------------
  if (boot.activity) renderChart(boot.activity, false);
  renderClouds(boot.clouds);
  renderMentions(boot.mentions);
  if (boot.heatmap) renderHeatmap(boot.heatmap);
  if (boot.canModerate) runSearch();
})();
