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
    url.searchParams.delete("page"); // actions pagination restarts when the period changes
    window.location.assign(url.toString());
  });
})();

// --- Recent moderator actions: header sorting (client-side over the current page) + the
// server-side filters and pagination. Filters/page changes fetch mod-actions.json and rebuild
// the table body + pagination IN PLACE - no navigation, so the viewer's scroll position (this
// section sits at the bottom of a long page) survives, and the page count reflects the
// FILTERED total (the old client-side row-hiding could only ever filter the 25 rendered rows).
// The URL is kept in sync via history.replaceState so refresh/bookmarks reproduce the state
// through the server render, which parses the same params.
(() => {
  const table = document.getElementById("mod-actions-table");
  if (!table) return;
  const tbody = document.getElementById("mod-actions-tbody") || table.querySelector("tbody");
  const filters = document.getElementById("mod-actions-filters");
  const paginationSlot = document.getElementById("mod-actions-pagination");

  // The server renders the "when" column in ITS OWN timezone (a no-JS fallback - EJS has no
  // access to the viewer's clock). Re-render it here from the row's epoch-ms data-ts so the
  // times match the VIEWER's timezone, like the log search results and the ban-context popup
  // already do. Same locale choice as the server-side fallback (html[lang] carries it).
  const pageLocale = document.documentElement.lang === "ru" ? "ru-RU" : "en-US";
  for (const row of tbody.querySelectorAll("tr[data-action]")) {
    const cell = row.cells[row.cells.length - 1];
    if (cell && row.dataset.ts) {
      cell.textContent = new Date(Number(row.dataset.ts)).toLocaleString(pageLocale);
    }
  }

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

  if (!filters || !paginationSlot) {
    applySort(currentSort.key, currentSort.dir);
    return;
  }

  // --- Filter state, read live from the dropdown inputs -----------------------------------

  function collectFilters() {
    const actions = [...filters.querySelectorAll('input[name="actions"]:checked')].map((i) => i.value);
    const mode = filters.querySelector('input[name="mod-filter-mode"]:checked')?.value || "include";
    const mods = [...filters.querySelectorAll('input[name="mods"]:checked')].map((i) => i.value);
    return {
      actions,
      mods: mode === "include" ? mods : [],
      excludeMods: mode === "exclude" ? mods : [],
    };
  }

  function anyFilterActive() {
    const f = collectFilters();
    return f.actions.length > 0 || f.mods.length > 0 || f.excludeMods.length > 0;
  }

  // "N selected" / "All" chips on the dropdown summaries.
  function updateSummaries() {
    const f = collectFilters();
    const set = (dropdownId, count) => {
      const el = document.querySelector(`#${dropdownId} [data-filter-summary]`);
      if (el) {
        el.textContent = count > 0 ? `${count} ${filters.dataset.labelSelected}` : filters.dataset.labelAll;
      }
    };
    set("action-filter-dropdown", f.actions.length);
    set("mod-filter-dropdown", f.mods.length || f.excludeMods.length);
  }

  // Query for both mod-actions.json and the address bar - the server render accepts the same
  // params, so a replaceState'd URL survives refresh and copy/paste.
  function buildQuery(page) {
    const params = new URLSearchParams(window.location.search);
    params.delete("actions");
    params.delete("mods");
    params.delete("excludeMods");
    const f = collectFilters();
    if (f.actions.length > 0) params.set("actions", f.actions.join(","));
    if (f.mods.length > 0) params.set("mods", f.mods.join(","));
    else if (f.excludeMods.length > 0) params.set("excludeMods", f.excludeMods.join(","));
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    return params;
  }

  // --- In-place rendering ------------------------------------------------------------------

  function cellEl(className, text) {
    const td = document.createElement("td");
    td.className = className;
    td.textContent = text; // chat-derived names/reasons - textContent only, never innerHTML
    return td;
  }

  // Mirrors the EJS row markup in statisticsMod.ejs - keep the two in sync.
  function renderRows(actions) {
    tbody.textContent = "";

    if (actions.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "px-4 py-6 text-center text-neutral-500";
      td.textContent = anyFilterActive() ? table.dataset.labelNofiltered : table.dataset.labelNoactions;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const a of actions) {
      const tr = document.createElement("tr");
      tr.className = "odd:bg-neutral-950 even:bg-neutral-900/40";
      tr.dataset.action = a.action;
      tr.dataset.mod = a.modName;
      tr.dataset.modid = String(a.modID ?? "");
      tr.dataset.target = a.targetName;
      tr.dataset.ts = String(new Date(a.timestamp).getTime());
      tr.dataset.id = a.id;
      tr.dataset.tta = a.TTA ?? "";

      const modCell = cellEl(`px-4 py-2 whitespace-nowrap${a.modColor ? "" : " text-neutral-400"}`, a.modName);
      if (a.modColor) modCell.style.color = a.modColor;
      const targetCell = cellEl(
        `px-4 py-2 whitespace-nowrap target-cell${a.targetColor ? "" : " text-neutral-400"}`,
        a.targetName
      );
      if (a.targetColor) targetCell.style.color = a.targetColor;
      const durationCell = cellEl(
        "px-4 py-2 text-neutral-400 whitespace-nowrap",
        a.durationLabel || table.dataset.labelNoduration
      );
      if (a.reason) durationCell.title = a.reason;

      tr.append(
        cellEl("px-4 py-2 text-neutral-200 whitespace-nowrap", a.action),
        modCell,
        targetCell,
        durationCell,
        cellEl("px-4 py-2 text-neutral-500 whitespace-nowrap", new Date(a.timestamp).toLocaleString(pageLocale))
      );
      tbody.appendChild(tr);
    }
  }

  // Mirrors the EJS pagination markup (the server-rendered version doubles as the no-JS
  // fallback; this rebuild takes over after the first in-place fetch).
  function renderPagination(page, totalPages) {
    paginationSlot.textContent = "";
    if (totalPages <= 1) return;

    const nav = document.createElement("nav");
    nav.className = "flex items-center justify-center gap-3 mt-4 text-xs";

    const item = (label, targetPage) => {
      if (targetPage === null) {
        const span = document.createElement("span");
        span.className = "px-3 py-1.5 rounded-md border border-neutral-900 text-neutral-700 select-none";
        span.textContent = label;
        return span;
      }
      const a = document.createElement("a");
      a.href = `?${buildQuery(targetPage)}`;
      a.dataset.page = String(targetPage);
      a.className =
        "px-3 py-1.5 rounded-md border border-neutral-800 text-neutral-300 hover:border-purple-600 hover:text-neutral-100 transition-colors";
      a.textContent = label;
      return a;
    };

    const label = document.createElement("span");
    label.className = "text-neutral-500 tabular-nums";
    label.textContent = `${paginationSlot.dataset.labelPage} ${page} / ${totalPages}`;

    nav.append(
      item(paginationSlot.dataset.labelPrev, page > 1 ? page - 1 : null),
      label,
      item(paginationSlot.dataset.labelNext, page < totalPages ? page + 1 : null)
    );
    paginationSlot.appendChild(nav);
  }

  // --- Fetch + wire-up ----------------------------------------------------------------------

  const endpoint = window.location.pathname.replace(/\/statistics\/mod\/?$/, "/mod-actions.json");
  let seq = 0; // responses can land out of order; only the newest may paint
  let debounceTimer = null;

  async function refresh(page) {
    const mine = ++seq;
    const res = await fetch(`${endpoint}?${buildQuery(page)}`, {
      headers: { Accept: "application/json" },
    }).catch(() => null);
    if (mine !== seq || !res || !res.ok) return;
    const data = await res.json();
    if (mine !== seq) return;

    renderRows(data.actions);
    // The server clamps the page (a filter change can shrink the set below the requested
    // page), so render pagination and the URL from ITS page, not the requested one.
    renderPagination(data.page, data.totalPages);
    history.replaceState(null, "", `${window.location.pathname}?${buildQuery(data.page)}`);
    applySort(currentSort.key, currentSort.dir);
    // The ban-context IIFE below re-binds its hover handlers to the fresh rows on this event.
    table.dispatchEvent(new CustomEvent("mod-actions:rendered"));
  }

  filters.addEventListener("change", () => {
    updateSummaries();
    clearTimeout(debounceTimer);
    // Debounced: checking three boxes in a row should cost one fetch, not three. A filter
    // change always restarts from page 1 - the old page number is meaningless in the new set.
    debounceTimer = setTimeout(() => refresh(1), 300);
  });

  for (const button of filters.querySelectorAll("[data-filter-clear]")) {
    button.addEventListener("click", () => {
      const dropdown = button.closest("details");
      dropdown?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = false;
      });
      updateSummaries();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refresh(1), 100);
    });
  }

  // Close an open dropdown when clicking anywhere else - <details> has no built-in light-dismiss.
  document.addEventListener("click", (event) => {
    for (const dropdown of filters.querySelectorAll("details[open]")) {
      if (!dropdown.contains(event.target)) dropdown.removeAttribute("open");
    }
  });

  // Pagination clicks fetch in place instead of navigating (the hrefs stay as the no-JS
  // fallback). Delegated: the nav is rebuilt on every refresh.
  paginationSlot.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-page]");
    if (!link) return;
    event.preventDefault();
    refresh(Number(link.dataset.page));
  });

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

  // Wider than tall: the side axis labels are start/end-anchored text that grows OUTWARD from
  // the pentagon, and with a square canvas the longer localized labels ("Присутствие",
  // "Reaction") were clipped at the panel edges. The extra width is pure label room - the
  // pentagon's radius still comes from the height.
  const WIDTH = 340;
  const HEIGHT = 230;
  const CX = WIDTH / 2;
  const CY = HEIGHT / 2;
  const RADIUS = HEIGHT / 2 - 42; // leave room for axis labels

  function polygonPoints(fractions) {
    return fractions
      .map((f, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
        return `${CX + Math.cos(angle) * RADIUS * f},${CY + Math.sin(angle) * RADIUS * f}`;
      })
      .join(" ");
  }

  function renderPentagon(name, scores) {
    const rings = [0.25, 0.5, 0.75, 1]
      .map((f) => `<polygon points="${polygonPoints(AXES.map(() => f))}" fill="none" stroke="#404040" stroke-opacity="0.5" stroke-width="1"/>`)
      .join("");
    const spokes = AXES.map((_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
      return `<line x1="${CX}" y1="${CY}" x2="${CX + Math.cos(angle) * RADIUS}" y2="${CY + Math.sin(angle) * RADIUS}" stroke="#404040" stroke-opacity="0.5" stroke-width="1"/>`;
    }).join("");
    const labels = AXES.map(({ label }, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
      const x = CX + Math.cos(angle) * (RADIUS + 16);
      const y = CY + Math.sin(angle) * (RADIUS + 16);
      const anchor = Math.abs(Math.cos(angle)) < 0.3 ? "middle" : Math.cos(angle) > 0 ? "start" : "end";
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" fill="#a3a3a3" font-size="10">${label}</text>`;
    }).join("");
    // Floor at 0.03 so a zero score still shows a sliver of shape at the center
    const shape = polygonPoints(scores.map((s) => Math.max(0.03, s)));
    const dots = scores
      .map((s, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
        const f = Math.max(0.03, s);
        return `<circle cx="${CX + Math.cos(angle) * RADIUS * f}" cy="${CY + Math.sin(angle) * RADIUS * f}" r="2.5" fill="#c084fc"/>`;
      })
      .join("");

    panel.innerHTML =
      `<p class="text-xs font-medium text-neutral-200 mb-1 text-center"></p>` +
      `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
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

// --- Ban-context popup: hovering a Target cell in the recent-actions table shows the message
// the user was actioned for plus up to 5 of their previous ones. Only wired up on rows whose
// TTA (moderator reaction time) is under 45s - beyond that the last logged message probably
// isn't what was acted on, so the popup would mislead (the server enforces the same cutoff).
// The context costs a DB query, so it's fetched lazily per row, cached, and the panel shows a
// spinner immediately so the viewer knows to keep the cursor still while it loads.
(() => {
  const table = document.getElementById("mod-actions-table");
  const panel = document.getElementById("ban-context");
  if (!table || !panel) return;

  const MAX_TTA_MS = 45000;
  const contextUrl = window.location.pathname.replace(/\/statistics\/mod\/?$/, "/mod-action-context.json");
  const cache = new Map(); // action id -> Promise of context JSON
  let activeId = null; // which row the panel currently belongs to (guards async races)

  function fetchContext(id) {
    if (!cache.has(id)) {
      const promise = fetch(`${contextUrl}?id=${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      // A failed fetch shouldn't poison the cache - drop it so the next hover retries.
      promise.catch(() => cache.delete(id));
      cache.set(id, promise);
    }
    return cache.get(id);
  }

  // All content is DOM-built with textContent - messages and names are user-controlled.
  function renderLoading(targetName) {
    panel.innerHTML = "";
    const title = document.createElement("p");
    title.className = "text-xs font-medium text-neutral-200 mb-2 text-center";
    title.textContent = targetName;
    const spinner = document.createElement("div");
    spinner.className = "h-5 w-5 mx-auto my-3 rounded-full border-2 border-neutral-600 border-t-purple-400 animate-spin";
    panel.append(title, spinner);
  }

  function renderContext(targetName, context) {
    panel.innerHTML = "";
    const title = document.createElement("p");
    title.className = "text-xs font-medium text-neutral-200 mb-0.5 text-center";
    title.textContent = targetName;
    const subtitle = document.createElement("p");
    subtitle.className = "text-[10px] text-neutral-500 mb-2 text-center";
    subtitle.textContent = panel.dataset.labelTitle;
    panel.append(title, subtitle);

    const messages = context && context.available ? context.messages : [];
    if (messages.length === 0) {
      const none = document.createElement("p");
      none.className = "text-xs text-neutral-500 text-center my-2";
      none.textContent = panel.dataset.labelNone;
      panel.append(none);
      return;
    }

    const list = document.createElement("div");
    list.className = "space-y-1.5";
    for (const item of messages) {
      const row = document.createElement("div");
      row.className = item.flagged
        ? "rounded-md border-l-2 border-purple-500 bg-purple-950/40 px-2 py-1"
        : "rounded-md bg-neutral-800/60 px-2 py-1";
      const time = document.createElement("span");
      time.className = "text-[10px] text-neutral-500 tabular-nums mr-1.5";
      time.textContent = new Date(item.timestamp).toLocaleTimeString();
      const text = document.createElement("span");
      text.className = item.flagged ? "text-xs text-neutral-100" : "text-xs text-neutral-300";
      text.textContent = item.message;
      row.append(time, text);
      list.append(row);
    }
    panel.append(list);
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

  function bindRows() {
    for (const row of table.querySelectorAll("tbody tr[data-id]")) {
      const tta = Number(row.dataset.tta);
      if (row.dataset.tta === "" || !(tta < MAX_TTA_MS)) continue;
      const cell = row.querySelector(".target-cell");
      if (!cell) continue;
      cell.classList.add("underline", "decoration-dotted", "cursor-help");

      cell.addEventListener("mouseenter", (event) => {
        const id = row.dataset.id;
        activeId = id;
        renderLoading(row.dataset.target);
        panel.hidden = false;
        positionPanel(event);
        fetchContext(id)
          .then((context) => {
            if (activeId !== id || panel.hidden) return; // cursor moved on - stale response
            renderContext(row.dataset.target, context);
            positionPanel(event);
          })
          .catch(() => {
            if (activeId !== id || panel.hidden) return;
            renderContext(row.dataset.target, null); // renders the "no messages" fallback
          });
      });
      cell.addEventListener("mousemove", positionPanel);
      cell.addEventListener("mouseleave", () => {
        activeId = null;
        panel.hidden = true;
      });
    }
  }

  bindRows();
  // In-place filter/pagination refreshes replace every row wholesale - re-bind the fresh
  // nodes (the fetch cache above persists across renders, so revisited rows stay instant).
  table.addEventListener("mod-actions:rendered", bindRows);
})();
