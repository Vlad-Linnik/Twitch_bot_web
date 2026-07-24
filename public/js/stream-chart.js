// /<channel>/statistics/chat - viewer count + chat-rate-per-bucket over one stream, with the
// stream's category shown as coloured segments along the bottom. The two series use INDEPENDENT
// y-axes - viewers on the left (red), messages on the right (blue) - because a channel with 4000
// viewers and 100-400 messages/min would otherwise pin the message line flat against the floor,
// hiding all of its shape. The two axes are colour-matched to their series (and to the legend
// swatches) so the reader can tell which scale reads which line; the tooltip still reports the
// raw values of both at once, so the exact numbers are never ambiguous even though the scales
// differ.
//
// Vanilla + inline SVG, same house style as user-dashboard.js/statistics-chat.js - no charting
// library. Two things this chart needs that the others don't: point X position is computed from
// REAL elapsed time (not even index-spacing), because the two series have different point
// densities (~5 min viewer samples vs adaptively-bucketed messages) and a missed poll tick should
// show as a real gap rather than being silently smoothed over; and the session picker plus every
// axis/tooltip label is built with the visitor's OWN browser timezone - no explicit `timeZone`
// appears anywhere in this file, so Intl/Date fall back to it automatically.
//
// Lines are drawn with a shape-preserving monotone cubic spline (Fritsch-Carlson), so the curve
// reads smoothly instead of angular WITHOUT inventing data: monotone interpolation is guaranteed
// not to overshoot, so no phantom viewer spike or dip ever appears between two real samples.
(function () {
  "use strict";

  const dataEl = document.getElementById("stats-chat-data");
  if (!dataEl) return;
  const boot = JSON.parse(dataEl.textContent);

  const $ = (id) => document.getElementById(id);
  const svgNs = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const node = document.createElementNS(svgNs, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  };

  const wrap = $("stream-chart-wrap");
  const emptyEl = $("stream-chart-empty");
  const select = $("stream-session-select");
  const liveBadge = $("stream-live-badge");
  const svg = $("stream-chart");
  const yAxis = $("stream-chart-yaxis");
  const yAxisRight = $("stream-chart-yaxis-right");
  const xAxis = $("stream-chart-xaxis");
  const categoriesEl = $("stream-chart-categories");
  const tooltip = $("stream-chart-tooltip");

  // Boot data predates this feature on a page that hasn't been re-rendered, or the markup is
  // missing - stay inert rather than throwing and taking the rest of the page's scripts down.
  if (!wrap || !select || !svg || !boot.sessions) return;

  const sessions = boot.sessions;
  if (sessions.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  // Validated against this page's dark surface (#171717) via the dataviz skill's palette
  // validator - CVD ΔE 19.2/normal ΔE 29.0, both well clear of the safety floors.
  const VIEWER_COLOR = "#e66767";
  const MESSAGE_COLOR = "#3987e5";
  const CHART_W = 800;
  const CHART_H = 200;
  const PLOT_PAD = 4;

  // Distinct, reasonably CVD-separable hues cycled across the DISTINCT categories a stream hops
  // through - assigned by first-appearance order and remembered per name, so the same game keeps
  // the same colour everywhere it appears in the strip. Identity still comes from the label +
  // box art + tooltip; the colour is a highlight, not the sole signal (a variety stream can pass
  // through more games than any fixed palette has hues, at which point colours repeat).
  const CATEGORY_PALETTE = [
    "#8b5cf6", "#06b6d4", "#f59e0b", "#ec4899", "#22c55e",
    "#f43f5e", "#3b82f6", "#eab308", "#14b8a6", "#a855f7",
  ];

  // Locale (number/date FORMAT style) follows the site's own chosen language, same as every
  // other chart on this site (user-dashboard.js's Intl calls) - but no explicit `timeZone` is
  // ever passed anywhere in this file, so the actual clock time always defaults to the
  // visitor's own browser/system timezone regardless of which UI language they're reading in.
  const numCompact = new Intl.NumberFormat(boot.locale, { notation: "compact", maximumFractionDigits: 1 });
  const timeFmt = new Intl.DateTimeFormat(boot.locale, { hour: "2-digit", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(boot.locale, { day: "numeric", month: "short" });
  const dateTimeFmt = new Intl.DateTimeFormat(boot.locale, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

  // ---------------------------------------------------------------------------------------
  // Session picker - grouped into <optgroup>s by the LOCAL calendar date of startedAt (not
  // endedAt, so a stream crossing local midnight has one unambiguous group), giving the
  // dropdown a small-calendar feel without an actual calendar-grid widget.
  // ---------------------------------------------------------------------------------------
  const localDateKey = (date) =>
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

  function populateSessionSelect(selectedId) {
    select.textContent = "";
    let group = null;
    let groupKey = null;

    sessions.forEach((s) => {
      const started = new Date(s.startedAt);
      const key = localDateKey(started);
      if (key !== groupKey) {
        group = document.createElement("optgroup");
        group.label = dateFmt.format(started);
        select.appendChild(group);
        groupKey = key;
      }
      const option = document.createElement("option");
      option.value = s.id;
      // A still-open session reads identically to a closed one at the same start time otherwise.
      option.textContent = s.endedAt ? timeFmt.format(started) : `${timeFmt.format(started)} ●`;
      if (s.id === selectedId) option.selected = true;
      group.appendChild(option);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Axes + gridlines
  // ---------------------------------------------------------------------------------------
  const yFor = (value, max, height) => height - PLOT_PAD - (value / max) * (height - 2 * PLOT_PAD);
  const xFor = (t, startMs, endMs) => (endMs <= startMs ? 0 : ((t - startMs) / (endMs - startMs)) * CHART_W);

  function drawGridlines() {
    for (const y of [PLOT_PAD, CHART_H / 2, CHART_H - PLOT_PAD]) {
      svg.appendChild(
        el("line", {
          x1: 0, y1: y, x2: CHART_W, y2: y,
          stroke: "#262626", "stroke-width": "1", "vector-effect": "non-scaling-stroke",
        })
      );
    }
  }

  // One axis column (left = viewers, right = messages). `color` tints the tick labels to match
  // that axis's own series, since the two axes now carry different scales.
  function fillYAxis(target, max, color) {
    target.textContent = "";
    for (const value of [max, max / 2, 0]) {
      const span = document.createElement("span");
      span.textContent = numCompact.format(Math.round(value));
      span.style.color = color;
      target.appendChild(span);
    }
  }

  const X_TICKS = 6;
  function fillXAxis(startMs, endMs) {
    xAxis.textContent = "";
    for (let i = 0; i < X_TICKS; i++) {
      const t = startMs + ((endMs - startMs) * i) / (X_TICKS - 1);
      const span = document.createElement("span");
      span.textContent = timeFmt.format(new Date(t));
      xAxis.appendChild(span);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Category strip - plain HTML segments (not SVG), widths proportional to real elapsed time.
  // Each distinct category gets its own highlight colour (a soft tint + a solid accent bar) and,
  // when Twitch has cover art for it, its box-art thumbnail. Colour is keyed to the category name
  // so the same game reads identically wherever it recurs; identity still comes primarily from the
  // label + art + tooltip (the palette repeats past 10 distinct games). A narrow segment simply
  // clips its own thumbnail/label via overflow-hidden - no width threshold to tune.
  // ---------------------------------------------------------------------------------------
  const colorForCategory = (name, assigned) => {
    if (!assigned.has(name)) assigned.set(name, CATEGORY_PALETTE[assigned.size % CATEGORY_PALETTE.length]);
    return assigned.get(name);
  };

  function renderCategories(segments, startMs, endMs) {
    categoriesEl.textContent = "";
    const totalMs = endMs - startMs;
    if (totalMs <= 0) return;
    const assigned = new Map();

    segments.forEach((seg) => {
      const segStart = new Date(seg.startAt).getTime();
      const segEnd = new Date(seg.endAt).getTime();
      const widthPct = ((segEnd - segStart) / totalMs) * 100;
      if (widthPct <= 0) return;

      const label = seg.category || "—";
      const color = seg.category ? colorForCategory(seg.category, assigned) : "#525252";

      const div = document.createElement("div");
      div.style.width = `${widthPct}%`;
      div.style.background = `${color}26`; // ~15% tint over the dark surface
      div.style.borderBottom = `2px solid ${color}`;
      div.className = "relative flex items-center gap-1 overflow-hidden min-w-0 text-neutral-200";
      div.title = `${label} — ${dateTimeFmt.format(segStart)} → ${
        seg.endAt ? dateTimeFmt.format(segEnd) : "…"
      }`;

      if (seg.boxArtUrl) {
        const img = document.createElement("img");
        img.src = seg.boxArtUrl;
        img.alt = "";
        img.loading = "lazy";
        img.className = "h-full w-auto shrink-0 object-cover";
        // A hotlink/CDN hiccup must never leave a broken-image icon - drop back to colour + label.
        img.onerror = () => img.remove();
        div.appendChild(img);
      }

      const span = document.createElement("span");
      span.className = "truncate px-1"; // category names come from Twitch, not chat - textContent anyway
      span.textContent = label;
      div.appendChild(span);

      categoriesEl.appendChild(div);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Line series
  // ---------------------------------------------------------------------------------------
  const screenPoints = (points, startMs, endMs, max) =>
    points.map((p) => ({ x: xFor(p.t, startMs, endMs), y: yFor(p.value, max, CHART_H) }));

  // Fritsch-Carlson monotone cubic Hermite spline over the screen-space points. Shape-preserving:
  // the tangent clamp guarantees the curve never overshoots the data, so smoothing introduces no
  // value the raw samples didn't contain (no invented peak between two points). X spacing is the
  // real elapsed-time spacing, which this handles because it works from the actual dx per segment.
  function buildSmoothPath(pts) {
    const n = pts.length;
    if (n === 0) return "";
    if (n === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (n === 2) {
      return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
    }

    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = pts[i + 1].x - pts[i].x;
      slope[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
    }

    const m = new Array(n);
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i++) {
      m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    }
    // Clamp tangents so each segment stays monotone (no overshoot).
    for (let i = 0; i < n - 1; i++) {
      if (slope[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / slope[i];
      const b = m[i + 1] / slope[i];
      const h = a * a + b * b;
      if (h > 9) {
        const tau = 3 / Math.sqrt(h);
        m[i] = tau * a * slope[i];
        m[i + 1] = tau * b * slope[i];
      }
    }

    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const c1x = pts[i].x + dx[i] / 3;
      const c1y = pts[i].y + (m[i] * dx[i]) / 3;
      const c2x = pts[i + 1].x - dx[i] / 3;
      const c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  function addEndDot(pts, color) {
    if (pts.length === 0) return;
    const last = pts[pts.length - 1];
    svg.appendChild(
      el("circle", {
        cx: last.x.toFixed(1),
        cy: last.y.toFixed(1),
        r: 4,
        fill: color,
        stroke: "#171717",
        "stroke-width": "2",
      })
    );
  }

  // ---------------------------------------------------------------------------------------
  // Crosshair + tooltip - one readout for both series at the nearest observed time, per the
  // dataviz skill's interaction guidance (the pointer never has to land on a line to get a
  // value). Snaps to the nearest point among BOTH series combined, since they don't share exact
  // timestamps.
  // ---------------------------------------------------------------------------------------
  function setupCrosshair(viewerPoints, messagePoints, startMs, endMs) {
    const merged = [...viewerPoints.map((p) => p.t), ...messagePoints.map((p) => p.t)].sort((a, b) => a - b);
    if (merged.length === 0) {
      svg.onpointermove = null;
      svg.onpointerleave = null;
      return;
    }

    let crosshair = svg.querySelector("[data-crosshair]");
    if (!crosshair) {
      crosshair = el("line", {
        y1: 0, y2: CHART_H, stroke: "#525252", "stroke-width": "1", "vector-effect": "non-scaling-stroke",
      });
      crosshair.setAttribute("data-crosshair", "1");
      crosshair.style.display = "none";
      svg.appendChild(crosshair);
    }

    const findNearest = (t) => {
      let nearest = merged[0];
      let bestDiff = Math.abs(t - nearest);
      for (const candidate of merged) {
        const diff = Math.abs(t - candidate);
        if (diff < bestDiff) { bestDiff = diff; nearest = candidate; }
      }
      return nearest;
    };

    // The two series don't share exact timestamps (~5 min viewer samples vs adaptively-bucketed
    // messages), so each series finds ITS OWN nearest point to the hovered time independently -
    // otherwise, per the dataviz guidance ("one tooltip, every series"), whichever series didn't
    // own the snapped crosshair timestamp would silently drop out of the readout.
    const nearestInSeries = (points, t) => {
      if (points.length === 0) return null;
      let nearest = points[0];
      let bestDiff = Math.abs(t - nearest.t);
      for (const p of points) {
        const diff = Math.abs(t - p.t);
        if (diff < bestDiff) { bestDiff = diff; nearest = p; }
      }
      return nearest;
    };

    const wrapEl = svg.parentElement; // the `.relative` container the tooltip positions within

    function onMove(event) {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const t = startMs + ratio * (endMs - startMs);
      const nearestT = findNearest(t);

      const x = xFor(nearestT, startMs, endMs);
      crosshair.setAttribute("x1", x.toFixed(1));
      crosshair.setAttribute("x2", x.toFixed(1));
      crosshair.style.display = "";

      const viewerAt = nearestInSeries(viewerPoints, t);
      const messageAt = nearestInSeries(messagePoints, t);

      tooltip.textContent = "";
      const time = document.createElement("div");
      time.className = "text-neutral-400 mb-1";
      time.textContent = dateTimeFmt.format(new Date(nearestT));
      tooltip.appendChild(time);

      const addRow = (color, label, value) => {
        if (value == null) return;
        const row = document.createElement("div");
        row.className = "flex items-center gap-1.5";
        const key = document.createElement("span");
        key.className = "inline-block w-2.5 h-0.5 rounded-full shrink-0";
        key.style.background = color;
        const text = document.createElement("span");
        text.className = "text-neutral-500";
        text.textContent = `${label}: `;
        const val = document.createElement("span");
        val.className = "text-neutral-100 font-medium";
        val.textContent = String(value);
        row.append(key, text, val);
        tooltip.appendChild(row);
      };
      addRow(VIEWER_COLOR, boot.streamChartLabels.viewers, viewerAt ? viewerAt.value : null);
      addRow(MESSAGE_COLOR, boot.streamChartLabels.messages, messageAt ? messageAt.value : null);

      tooltip.classList.remove("hidden");
      const wrapRect = wrapEl.getBoundingClientRect();
      const svgLeftInWrap = rect.left - wrapRect.left;
      let left = svgLeftInWrap + (x / CHART_W) * rect.width + 12;
      if (left + 160 > wrapRect.width) left = svgLeftInWrap + (x / CHART_W) * rect.width - 12 - tooltip.offsetWidth;
      tooltip.style.left = `${Math.max(0, left)}px`;
      tooltip.style.top = "4px";
    }

    function onLeave() {
      crosshair.style.display = "none";
      tooltip.classList.add("hidden");
    }

    svg.onpointermove = onMove;
    svg.onpointerleave = onLeave;
  }

  // ---------------------------------------------------------------------------------------
  // Render one session's chart data (server-inlined for the newest session, or fetched fresh
  // on a session-picker change).
  // ---------------------------------------------------------------------------------------
  function render(data) {
    svg.textContent = "";
    wrap.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    // The tooltip/crosshair live outside the SVG's own subtree (a sibling HTML div), so clearing
    // the SVG alone leaves a stale readout from the PREVIOUS session on screen until the next
    // mousemove - hide it explicitly on every re-render (first paint and session switches alike).
    tooltip.classList.add("hidden");

    const session = data.session;
    liveBadge.hidden = !!session.endedAt;

    const startMs = new Date(session.startedAt).getTime();
    const endMs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();

    const viewerPoints = (data.viewerSamples || []).map((s) => ({
      t: new Date(s.timestamp).getTime(),
      value: s.viewerCount,
    }));
    const messagePoints = (data.messageBuckets || []).map((b) => ({
      t: new Date(b.timestamp).getTime(),
      value: b.count,
    }));

    // Independent scales per series (see the header comment) - each is normalised to its own max
    // so both lines use the full plot height regardless of the other's magnitude.
    const maxViewers = Math.max(1, ...viewerPoints.map((p) => p.value));
    const maxMessages = Math.max(1, ...messagePoints.map((p) => p.value));

    drawGridlines();
    fillYAxis(yAxis, maxViewers, VIEWER_COLOR);
    if (yAxisRight) fillYAxis(yAxisRight, maxMessages, MESSAGE_COLOR);
    fillXAxis(startMs, endMs);
    renderCategories(data.categorySegments || [], startMs, endMs);

    const viewerScreen = screenPoints(viewerPoints, startMs, endMs, maxViewers);
    const messageScreen = screenPoints(messagePoints, startMs, endMs, maxMessages);

    svg.appendChild(
      el("path", {
        d: buildSmoothPath(viewerScreen),
        fill: "none", stroke: VIEWER_COLOR, "stroke-width": "2",
        "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      })
    );
    svg.appendChild(
      el("path", {
        d: buildSmoothPath(messageScreen),
        fill: "none", stroke: MESSAGE_COLOR, "stroke-width": "2",
        "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      })
    );
    addEndDot(viewerScreen, VIEWER_COLOR);
    addEndDot(messageScreen, MESSAGE_COLOR);

    setupCrosshair(viewerPoints, messagePoints, startMs, endMs);
  }

  async function loadSession(id) {
    const res = await fetch(`/${encodeURIComponent(boot.channel)}/stream-stats.json?session=${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    render(await res.json());
  }

  select.addEventListener("change", () => loadSession(select.value));

  // ---------------------------------------------------------------------------------------
  // First paint - the newest session's data is already server-inlined (boot.streamChart), so
  // opening the page never re-fetches what the server already computed.
  // ---------------------------------------------------------------------------------------
  populateSessionSelect(sessions[0].id);
  if (boot.streamChart) render(boot.streamChart);
})();
