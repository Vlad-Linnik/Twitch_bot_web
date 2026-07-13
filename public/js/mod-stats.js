// Moderator statistics table: column sorting, the "show moderators with no data" toggle, the
// skill-pentagon hover chart, the ?period= toggle, and the recent-actions table's sort/filters.
// Wrapped in IIFEs - classic <script> tags on a page share one global lexical scope
// (logout-confirm.js already owns top-level names like `form`).

// --- Period toggle: unlike the chat page's fetch-based toggles, this one NAVIGATES. The mod
// table is server-rendered (sort data-attrs, pentagon hookup, inactive rows), so a reload keeps
// EJS the single source of its markup.
(() => {
  const group = document.querySelector('[data-period-toggle="modstats"]');
  if (!group) return;
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-period]");
    if (!button) return;
    const url = new URL(window.location.href);
    url.searchParams.set("period", button.dataset.period);
    window.location.assign(url.toString());
  });
})();

// --- Recent moderator actions: header sorting + action/moderator filters, purely client-side
// over the (at most 25) server-rendered rows.
(() => {
  const table = document.getElementById("mod-actions-table");
  if (!table) return;
  const tbody = table.querySelector("tbody");

  let currentSort = { key: "when", dir: -1 }; // server order: newest first

  function applySort(key, dir) {
    currentSort = { key, dir };
    const rows = [...tbody.querySelectorAll("tr[data-action]")];
    rows.sort((a, b) => {
      if (key === "when") return (Number(a.dataset.ts) - Number(b.dataset.ts)) * dir;
      const map = { action: "action", mod: "mod", target: "target" };
      const va = (a.dataset[map[key]] || "").toLowerCase();
      const vb = (b.dataset[map[key]] || "").toLowerCase();
      return va.localeCompare(vb) * dir;
    });
    rows.forEach((row) => tbody.appendChild(row));

    for (const th of table.querySelectorAll("th[data-sort]")) {
      const marker = th.dataset.sort === key ? (dir === 1 ? " ▲" : " ▼") : "";
      th.querySelector(".sort-marker")?.remove();
      if (marker) {
        const span = document.createElement("span");
        span.className = "sort-marker text-purple-400";
        span.textContent = marker;
        th.appendChild(span);
      }
    }
  }

  for (const th of table.querySelectorAll("th[data-sort]")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      // Time starts newest-first, text columns ascending; a second click flips it.
      const firstDir = key === "when" ? -1 : 1;
      const dir = currentSort.key === key ? -currentSort.dir : firstDir;
      applySort(key, dir);
    });
  }

  const actionFilter = document.getElementById("action-filter");
  const modFilter = document.getElementById("mod-filter");

  function applyFilters() {
    const action = actionFilter?.value || "";
    const mod = modFilter?.value || "";
    for (const row of tbody.querySelectorAll("tr[data-action]")) {
      row.hidden =
        (action !== "" && row.dataset.action !== action) || (mod !== "" && row.dataset.mod !== mod);
    }
  }

  actionFilter?.addEventListener("change", applyFilters);
  modFilter?.addEventListener("change", applyFilters);

  applySort(currentSort.key, currentSort.dir);
})();

(() => {
  const table = document.getElementById("mod-stats-table");
  if (!table) return;
  const tbody = table.querySelector("tbody");

  // --- Column sorting -----------------------------------------------------------------

  const METRICS = ["chat", "presence", "reaction", "severity", "actions"];
  let currentSort = { key: "actions", dir: -1 };

  function rowValue(row, key) {
    if (key === "name") return (row.dataset.name || "").toLowerCase();
    const raw = row.dataset[key];
    // Empty string = no data (inactive mods, or a null reaction speed): always sorts last,
    // whichever direction the column is sorted in.
    if (raw === "" || raw === undefined) return null;
    return parseFloat(raw);
  }

  function applySort(key, dir) {
    currentSort = { key, dir };
    const rows = [...tbody.querySelectorAll("tr[data-name]")];
    rows.sort((a, b) => {
      const va = rowValue(a, key);
      const vb = rowValue(b, key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    rows.forEach((row) => tbody.appendChild(row));

    for (const th of table.querySelectorAll("th[data-sort]")) {
      const marker = th.dataset.sort === key ? (dir === 1 ? " ▲" : " ▼") : "";
      th.querySelector(".sort-marker")?.remove();
      if (marker) {
        const span = document.createElement("span");
        span.className = "sort-marker text-purple-400";
        span.textContent = marker;
        th.appendChild(span);
      }
    }
  }

  for (const th of table.querySelectorAll("th[data-sort]")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      // Metrics start descending (biggest first), names ascending; a second click flips it.
      const firstDir = key === "name" ? 1 : -1;
      const dir = currentSort.key === key ? -currentSort.dir : firstDir;
      applySort(key, dir);
    });
  }

  // --- "Show moderators with no data" toggle -------------------------------------------

  const emptyToggle = document.getElementById("show-empty-mods");
  emptyToggle?.addEventListener("change", () => {
    for (const row of tbody.querySelectorAll("tr[data-empty]")) {
      row.hidden = !emptyToggle.checked;
    }
  });

  // --- Skill pentagon on hover ----------------------------------------------------------

  const panel = document.getElementById("skill-polygon");
  if (!panel) return;

  const AXES = [
    { key: "chat", label: table.dataset.labelChat },
    { key: "presence", label: table.dataset.labelPresence },
    { key: "reaction", label: table.dataset.labelReaction },
    { key: "severity", label: table.dataset.labelSeverity },
    { key: "actions", label: table.dataset.labelActions },
  ];

  // Normalize each metric against the extremes across moderators that have data, to a 0..1
  // score per axis. Reaction speed is inverted - a FASTER average reaction is the better skill.
  function computeScores(row) {
    const dataRows = [...tbody.querySelectorAll("tr[data-name]:not([data-empty])")];
    return AXES.map(({ key }) => {
      const value = rowValue(row, key);
      if (value === null) return 0;
      const values = dataRows.map((r) => rowValue(r, key)).filter((v) => v !== null);
      const max = Math.max(...values);
      const min = Math.min(...values);
      if (key === "reaction") {
        if (max === min) return 1;
        return (max - value) / (max - min);
      }
      return max > 0 ? value / max : 0;
    });
  }

  const SIZE = 230;
  const CENTER = SIZE / 2;
  const RADIUS = SIZE / 2 - 42; // leave room for axis labels

  function polygonPoints(fractions) {
    return fractions
      .map((f, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
        return `${CENTER + Math.cos(angle) * RADIUS * f},${CENTER + Math.sin(angle) * RADIUS * f}`;
      })
      .join(" ");
  }

  function renderPentagon(name, scores) {
    const rings = [0.25, 0.5, 0.75, 1]
      .map((f) => `<polygon points="${polygonPoints(AXES.map(() => f))}" fill="none" stroke="#404040" stroke-opacity="0.5" stroke-width="1"/>`)
      .join("");
    const spokes = AXES.map((_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
      return `<line x1="${CENTER}" y1="${CENTER}" x2="${CENTER + Math.cos(angle) * RADIUS}" y2="${CENTER + Math.sin(angle) * RADIUS}" stroke="#404040" stroke-opacity="0.5" stroke-width="1"/>`;
    }).join("");
    const labels = AXES.map(({ label }, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
      const x = CENTER + Math.cos(angle) * (RADIUS + 16);
      const y = CENTER + Math.sin(angle) * (RADIUS + 16);
      const anchor = Math.abs(Math.cos(angle)) < 0.3 ? "middle" : Math.cos(angle) > 0 ? "start" : "end";
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" fill="#a3a3a3" font-size="10">${label}</text>`;
    }).join("");
    // Floor at 0.03 so a zero score still shows a sliver of shape at the center
    const shape = polygonPoints(scores.map((s) => Math.max(0.03, s)));
    const dots = scores
      .map((s, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
        const f = Math.max(0.03, s);
        return `<circle cx="${CENTER + Math.cos(angle) * RADIUS * f}" cy="${CENTER + Math.sin(angle) * RADIUS * f}" r="2.5" fill="#c084fc"/>`;
      })
      .join("");

    panel.innerHTML =
      `<p class="text-xs font-medium text-neutral-200 mb-1 text-center"></p>` +
      `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
      rings + spokes +
      `<polygon points="${shape}" fill="#a855f7" fill-opacity="0.25" stroke="#c084fc" stroke-width="2" stroke-linejoin="round"/>` +
      dots + labels +
      `</svg>`;
    panel.querySelector("p").textContent = name; // textContent, never innerHTML, for the user-controlled name
  }

  function positionPanel(event) {
    const pad = 16;
    const rect = panel.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY - rect.height / 2;
    if (x + rect.width > window.innerWidth - pad) x = event.clientX - rect.width - pad;
    y = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  for (const row of tbody.querySelectorAll("tr[data-name]:not([data-empty])")) {
    row.addEventListener("mouseenter", (event) => {
      renderPentagon(row.dataset.name, computeScores(row));
      panel.hidden = false;
      positionPanel(event);
    });
    row.addEventListener("mousemove", positionPanel);
    row.addEventListener("mouseleave", () => {
      panel.hidden = true;
    });
  }

  applySort(currentSort.key, currentSort.dir);
})();
