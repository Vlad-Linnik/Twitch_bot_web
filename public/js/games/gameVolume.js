// Shared, persisted master volume for every on-site game's sound effects.
// One value (0-1) in localStorage, read by every game's playSound() as a
// multiplier on that sound's own base volume, and driven by a single
// <input type="range" data-game-volume-slider> control (partials/
// gameVolumeControl.ejs) included on any game page that has sound. Loaded
// before each game's own script (non-deferred, first in <head>/body) so
// window.gameVolume already exists by the time a game's IIFE runs.
(function () {
  "use strict";

  const STORAGE_KEY = "gameVolume";
  const DEFAULT_VOLUME = 0.5;

  function clamp(v) {
    return Math.min(1, Math.max(0, v));
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      /* storage blocked (private mode/permissions) - fall back to default, in-memory only */
    }
    const v = raw == null ? DEFAULT_VOLUME : parseFloat(raw);
    return Number.isFinite(v) ? clamp(v) : DEFAULT_VOLUME;
  }

  let volume = load();
  const listeners = new Set();

  function set(v) {
    volume = clamp(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(volume));
    } catch (_) {
      /* ignore - volume still applies for the rest of this tab's session */
    }
    listeners.forEach((cb) => cb(volume));
  }

  // Cross-tab sync: changing the slider on one open game page updates any
  // other game page open in another tab too.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return;
    const v = parseFloat(e.newValue);
    if (!Number.isFinite(v)) return;
    volume = clamp(v);
    listeners.forEach((cb) => cb(volume));
  });

  window.gameVolume = {
    get: () => volume,
    set,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  function wireSliders() {
    const sliders = document.querySelectorAll("[data-game-volume-slider]");
    if (!sliders.length) return;
    sliders.forEach((el) => {
      el.value = String(Math.round(volume * 100));
      el.addEventListener("input", () => set(Number(el.value) / 100));
    });
    window.gameVolume.onChange((v) => {
      const pct = String(Math.round(v * 100));
      sliders.forEach((el) => {
        if (el.value !== pct) el.value = pct;
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSliders);
  } else {
    wireSliders();
  }
})();
