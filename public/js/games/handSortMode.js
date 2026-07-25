// Shared, persisted hand-sort preference for card games (Durak, Sunduchki).
// One value ("suit" | "rank") in localStorage per game, read by that game's
// own sort comparator, driven by <button data-hand-sort-btn
// data-sort-value="suit|rank"> controls (partials/handSortControl.ejs)
// included on any card-game page - same "one persisted value drives every
// instance on the page" shape as gameVolume.js.
//
// The storage key AND default differ per game (Durak's pre-existing sort was
// suit-grouped, trump-last; Sunduchki's was rank-then-suit) - each game's
// handSortControl include stamps data-hand-sort-key/-default on its wrapper,
// read here once at load so flipping the toggle on one game never touches
// the other's preference or silently changes its default look.
//
// Loaded before each game's own script (deferred, but earlier in document
// order so it still runs first) so window.handSortMode already exists by the
// time a game's IIFE runs.
(function () {
  "use strict";

  const VALID = new Set(["suit", "rank"]);
  const configEl = document.querySelector("[data-hand-sort-key]");
  const STORAGE_KEY = (configEl && configEl.dataset.handSortKey) || "handSortMode";
  const DEFAULT_MODE = configEl && configEl.dataset.handSortDefault === "rank" ? "rank" : "suit";

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      /* storage blocked (private mode/permissions) - fall back to default, in-memory only */
    }
    return VALID.has(raw) ? raw : DEFAULT_MODE;
  }

  let mode = load();
  const listeners = new Set();

  function set(next) {
    if (!VALID.has(next) || next === mode) return;
    mode = next;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (_) {
      /* ignore - preference still applies for the rest of this tab's session */
    }
    listeners.forEach((cb) => cb(mode));
  }

  // Cross-tab sync: changing the toggle on one open game page updates any
  // other tab open on the same game's page too - same technique as
  // gameVolume.js.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || !VALID.has(e.newValue)) return;
    mode = e.newValue;
    listeners.forEach((cb) => cb(mode));
  });

  window.handSortMode = {
    get: () => mode,
    set,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  function wireButtons() {
    const buttons = document.querySelectorAll("[data-hand-sort-btn]");
    if (!buttons.length) return;
    function paint() {
      buttons.forEach((btn) => {
        const active = btn.dataset.sortValue === mode;
        btn.setAttribute("aria-pressed", String(active));
        btn.classList.toggle("bg-purple-600", active);
        btn.classList.toggle("text-white", active);
        btn.classList.toggle("bg-neutral-800", !active);
        btn.classList.toggle("text-neutral-400", !active);
        btn.classList.toggle("hover:bg-neutral-700", !active);
      });
    }
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => set(btn.dataset.sortValue));
    });
    window.handSortMode.onChange(paint);
    paint();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireButtons);
  } else {
    wireButtons();
  }
})();
