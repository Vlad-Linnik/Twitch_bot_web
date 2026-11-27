// Rating a film or game straight from the grid (views/partials/mediaCards.ejs), without opening it.
// Each tile has a star link to its card's own picker (#rating) - that is the no-JS path. This
// script turns the click into the grid's one shared ten-star panel ([data-quick-panel] in
// views/mediaGrid.ejs), placed under the tile's star, posting to the same /rate route the card's
// page uses. On success the tile's star, its readout and the viewers' average on the poster are
// patched in place, with public/js/star-burst.js's animation.
// Delegated on document, so tiles appended by infinite-list.js work without rebinding.
// Plain script sharing the page's global scope: everything stays inside the IIFE.
(() => {
  const panel = document.querySelector("[data-quick-panel]");
  if (!panel) return;
  const group = panel.querySelector("[data-quick-stars]");
  const stars = [...panel.querySelectorAll("[data-star]")];
  const note = panel.querySelector("[data-quick-note]");
  const fill = (template, n) => template.replace("{{n}}", String(n));

  const MINE = ["bg-(--sec-accent)/15", "ring-(--sec-accent)/50", "text-white", "hover:bg-(--sec-accent)/25"];
  const NONE = ["bg-white/5", "ring-white/10", "text-stone-400", "hover:ring-(--sec-accent)/60", "hover:text-(--sec-accent-soft)"];
  const STAR_MINE = ["text-(--sec-accent)"];
  const STAR_NONE = ["text-stone-500", "group-hover/rate:text-(--sec-accent-soft)"];

  let trigger = null;
  let current = 0;
  let busy = false;
  let closeTimer = null;

  function paint(n) {
    for (const star of stars) star.dataset.lit = Number(star.dataset.star) <= n ? "1" : "0";
  }

  function sync() {
    for (const star of stars) {
      const n = Number(star.dataset.star);
      const isMine = n === current;
      star.setAttribute("aria-checked", String(isMine));
      const label = fill(isMine ? panel.dataset.labelClear : panel.dataset.labelPick, n);
      star.setAttribute("aria-label", label);
      star.title = label;
      star.tabIndex = n === (current || 1) ? 0 : -1;
    }
    paint(current);
  }

  function place() {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    // Under the star when it fits, otherwise above it.
    const top = r.bottom + 6 + h <= vh - 8 ? r.bottom + 6 : Math.max(8, r.top - 6 - h);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function open(next) {
    clearTimeout(closeTimer);
    trigger = next;
    current = Number(next.dataset.current) || 0;
    note.hidden = true;
    note.textContent = "";
    sync();
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    place();
    const target = panel.querySelector('[data-star][tabindex="0"]');
    if (target) target.focus({ preventScroll: true });
    // Focusing the first star previews it; on opening that would read as a score already given.
    paint(current);
  }

  function close({ refocus = false } = {}) {
    clearTimeout(closeTimer);
    if (panel.hidden) return;
    panel.hidden = true;
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      if (refocus) trigger.focus({ preventScroll: true });
    }
    trigger = null;
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-quick-rate]");
    if (link) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (trigger === link && !panel.hidden) close();
      else open(link);
      return;
    }
    if (!panel.hidden && !panel.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close({ refocus: true });
  });
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, { passive: true });

  for (const star of stars) {
    star.addEventListener("mouseenter", () => paint(Number(star.dataset.star)));
    star.addEventListener("focus", () => paint(Number(star.dataset.star)));
    star.addEventListener("click", () => rate(star));
  }
  group.addEventListener("mouseleave", () => paint(current));
  group.addEventListener("keydown", (event) => {
    const index = stars.indexOf(document.activeElement);
    if (index === -1) return;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(index + 1, stars.length - 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = stars.length - 1;
    else if (event.key === "Tab") return close({ refocus: true });
    if (next === null) return;
    event.preventDefault();
    stars[index].tabIndex = -1;
    stars[next].tabIndex = 0;
    stars[next].focus();
  });

  // The tile's own star link: readout, colours, tooltip.
  function paintTrigger(link, value) {
    link.dataset.current = value ? String(value) : "";
    const readout = link.querySelector("[data-quick-readout]");
    if (readout) readout.textContent = value ? String(value) : readout.dataset.empty;
    link.title = value ? fill(panel.dataset.titleMine, value) : panel.dataset.titleEmpty;
    for (const c of MINE) link.classList.toggle(c, Boolean(value));
    for (const c of NONE) link.classList.toggle(c, !value);
    const svg = link.querySelector("[data-quick-star]");
    if (svg) {
      for (const c of STAR_MINE) svg.classList.toggle(c, Boolean(value));
      for (const c of STAR_NONE) svg.classList.toggle(c, !value);
    }
    if (readout && typeof readout.animate === "function") {
      readout.animate([{ transform: "translateY(5px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, delay: 250, easing: "ease-out", fill: "backwards" });
    }
  }

  // The poster's score line (partials/ratingTrio.ejs): the viewers' average, or the streamer's own.
  function paintTrio(tile, key, value) {
    const cell = tile && tile.querySelector(`[data-trio="${key}"]`);
    const out = cell && cell.querySelector("[data-trio-value]");
    if (!out) return;
    const text = value === null || value === undefined ? "—" : key === "viewers" ? value.toFixed(1) : String(value);
    if (out.textContent === text) return;
    out.textContent = text;
    cell.classList.toggle("text-stone-500", text === "—");
    if (typeof out.animate === "function") {
      out.animate([{ transform: "scale(1.5)", color: "#fde68a" }, { transform: "scale(1)" }], { duration: 500, delay: 350, easing: "cubic-bezier(.3,.7,.3,1)" });
    }
  }

  async function rate(star) {
    if (busy || !trigger) return;
    busy = true;
    const link = trigger;
    const picked = Number(star.dataset.star);
    const clearing = picked === current;
    const body = new URLSearchParams({ _csrf: panel.dataset.csrf, value: clearing ? "clear" : String(picked) });
    try {
      const response = await fetch(link.dataset.quickRate, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `status ${response.status}`);

      current = clearing ? 0 : data.value;
      sync();
      paintTrigger(link, current);
      const tile = link.closest("[data-list-item]");
      paintTrio(tile, "viewers", data.average);
      if ("streamer" in data) paintTrio(tile, "streamer", data.streamer);

      const svg = link.querySelector("[data-quick-star]");
      if (clearing) {
        if (window.starBurst) window.starBurst(svg, { clear: true });
      } else {
        if (window.starCascade) window.starCascade(stars.slice(0, current).map((s) => s.querySelector("svg")));
        if (window.starBurst) window.starBurst(svg);
      }

      // A score that counts needs no reading: the tile already shows it, so the panel goes once the
      // cascade has played. One that does not count, or a cleared one, stays a moment on its note.
      const text = clearing ? panel.dataset.noteCleared : data.counted ? null : panel.dataset.noteNotCounted;
      note.hidden = !text;
      note.textContent = text || "";
      place();
      closeTimer = setTimeout(() => close(), text ? 2600 : 850);
    } catch {
      paint(current);
      note.hidden = false;
      note.textContent = panel.dataset.noteError;
    } finally {
      busy = false;
    }
  }
})();
