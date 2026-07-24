// /<channel>/statistics/chat - viewer count + chat-rate-per-bucket over one stream, with the
// stream's category shown as segments along the bottom. Both series share ONE y-axis (a dual-axis
// chart with two independent scales is a classic distortion of how the reader compares the two
// lines) - the tradeoff is that a channel whose viewer count and message rate differ by an order
// of magnitude will show one series reading nearly flat, which is an honest reflection of the
// data, not a chart bug.
//
// Vanilla + inline SVG, same house style as user-dashboard.js/statistics-chat.js - no charting
// library. Two things this chart needs that the others don't: point X position is computed from
// REAL elapsed time (not even index-spacing), because the two series have different point
// densities (~5 min viewer samples vs adaptively-bucketed messages) and a missed poll tick should
// show as a real gap rather than being silently smoothed over; and the session picker plus every
// axis/tooltip label is built with the visitor's OWN browser timezone - no explicit `timeZone`
// appears anywhere in this file, so Intl/Date fall back to it automatically.
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

  function fillYAxis(max) {
    yAxis.textContent = "";
    for (const value of [max, max / 2, 0]) {
      const span = document.createElement("span");
      span.textContent = numCompact.format(Math.round(value));
      yAxis.appendChild(span);
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
  // Alternating neutral shades separate adjacent segments regardless of how many distinct games
  // appear in one stream (a variety stream can hop through more games than any fixed categorical
  // palette could assign a distinct, CVD-safe hue to) - identity comes from the label/tooltip,
  // never from the shade.
  // ---------------------------------------------------------------------------------------
  function renderCategories(segments, startMs, endMs) {
    categoriesEl.textContent = "";
    const totalMs = endMs - startMs;
    if (totalMs <= 0) return;

    segments.forEach((seg, i) => {
      const segStart = new Date(seg.startAt).getTime();
      const segEnd = new Date(seg.endAt).getTime();
      const widthPct = ((segEnd - segStart) / totalMs) * 100;
      if (widthPct <= 0) return;

      const label = seg.category || "—";
      const div = document.createElement("div");
      div.style.width = `${widthPct}%`;
      div.style.background = i % 2 === 0 ? "#262626" : "#1f1f1f";
      div.className = "flex items-center justify-center truncate px-1 text-neutral-400";
      div.textContent = label; // category names come from Twitch, not chat - textContent on principle anyway
      div.title = `${label} — ${dateTimeFmt.format(segStart)} → ${
        seg.endAt ? dateTimeFmt.format(segEnd) : "…"
      }`;
      categoriesEl.appendChild(div);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Line series
  // ---------------------------------------------------------------------------------------
  function buildLinePath(points, startMs, endMs, max) {
    if (points.length === 0) return "";
    let d = "";
    points.forEach((p, i) => {
      const x = xFor(p.t, startMs, endMs).toFixed(1);
      const y = yFor(p.value, max, CHART_H).toFixed(1);
      d += `${i === 0 ? "M" : "L"} ${x} ${y} `;
    });
    return d.trim();
  }

  function addEndDot(points, color, startMs, endMs, max) {
    if (points.length === 0) return;
    const last = points[points.length - 1];
    svg.appendChild(
      el("circle", {
        cx: xFor(last.t, startMs, endMs).toFixed(1),
        cy: yFor(last.value, max, CHART_H).toFixed(1),
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

    const max = Math.max(1, ...viewerPoints.map((p) => p.value), ...messagePoints.map((p) => p.value));

    drawGridlines();
    fillYAxis(max);
    fillXAxis(startMs, endMs);
    renderCategories(data.categorySegments || [], startMs, endMs);

    svg.appendChild(
      el("path", {
        d: buildLinePath(viewerPoints, startMs, endMs, max),
        fill: "none", stroke: VIEWER_COLOR, "stroke-width": "2",
        "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      })
    );
    svg.appendChild(
      el("path", {
        d: buildLinePath(messagePoints, startMs, endMs, max),
        fill: "none", stroke: MESSAGE_COLOR, "stroke-width": "2",
        "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      })
    );
    addEndDot(viewerPoints, VIEWER_COLOR, startMs, endMs, max);
    addEndDot(messagePoints, MESSAGE_COLOR, startMs, endMs, max);

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
