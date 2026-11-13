// Seasonal theme: the viewer's switch in the nav, and the moving parts (falling snow, the
// cursor's trail). The static decor is CSS (public/css/seasonal.css) and is already on screen
// before this runs; head.ejs's inline script settled html.season-on / html.season-motion before
// first paint, so this file only has to keep them in sync with what the viewer clicks.
//
// Plain script sharing one global scope with every other page script: everything lives inside
// the IIFE, nothing is declared at the top level.
(() => {
  const root = document.documentElement;
  const themeId = root.dataset.season;
  if (!themeId) return;

  const STORAGE_KEY = "seasonalDecor"; // same key as head.ejs's inline reader
  const PREFS = ["full", "static", "off"];
  const quiet = root.hasAttribute("data-season-quiet");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  function storedPref() {
    const server = root.dataset.seasonPref;
    if (PREFS.includes(server)) return server;
    try {
      const local = localStorage.getItem(STORAGE_KEY);
      return PREFS.includes(local) ? local : null;
    } catch {
      return null;
    }
  }

  let pref = storedPref();

  const decorOn = () => pref !== "off";
  const motionOn = () => decorOn() && (pref === "full" || (pref === null && !reducedMotion.matches));

  // ------------------------------------------------------------------ effects

  function makeCanvas(className, parent) {
    const canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.setAttribute("aria-hidden", "true");
    parent.appendChild(canvas);
    return canvas;
  }

  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // A six-armed flake drawn once to an offscreen canvas and stamped with drawImage - far
  // cheaper per frame than stroking the arms for every particle.
  function flakeSprite(size) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const mid = size / 2;
    const arm = mid - 1.5;
    g.strokeStyle = "#f2f8ff";
    g.lineWidth = Math.max(1.2, size / 14);
    g.lineCap = "round";
    g.translate(mid, mid);
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, -arm);
      g.moveTo(0, -arm * 0.55);
      g.lineTo(arm * 0.28, -arm * 0.78);
      g.moveTo(0, -arm * 0.55);
      g.lineTo(-arm * 0.28, -arm * 0.78);
      g.stroke();
      g.rotate(Math.PI / 3);
    }
    return c;
  }

  // Falling snow behind the content (inside .season-backdrop, which sits at z-index -1).
  function createSnowfall() {
    const host = document.querySelector(".season-backdrop");
    if (!host) return null;
    let canvas = null;
    let ctx = null;
    let w = 0;
    let h = 0;
    let flakes = [];
    let raf = 0;
    let last = 0;

    function seed() {
      const count = Math.max(24, Math.min(90, Math.round((w * h) / 16000)));
      flakes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.7 + Math.random() * 1.9,
        vy: 14 + Math.random() * 32,
        phase: Math.random() * Math.PI * 2,
        sway: 6 + Math.random() * 14,
        alpha: 0.25 + Math.random() * 0.5,
      }));
    }

    function frame(t) {
      raf = requestAnimationFrame(frame);
      // A long gap (tab in background, bfcache) is not a reason for every flake to jump.
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#eef6ff";
      for (const f of flakes) {
        f.y += f.vy * dt;
        f.phase += dt * 0.8;
        if (f.y - f.r > h) {
          f.y = -f.r;
          f.x = Math.random() * w;
        }
        const x = f.x + Math.sin(f.phase) * f.sway;
        ctx.globalAlpha = f.alpha;
        ctx.beginPath();
        ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function resize() {
      if (!canvas) return;
      ({ ctx, w, h } = fitCanvas(canvas));
      seed();
    }

    return {
      start() {
        if (canvas) return;
        canvas = makeCanvas("season-snowfall", host);
        resize();
        last = 0;
        raf = requestAnimationFrame(frame);
      },
      stop() {
        if (!canvas) return;
        cancelAnimationFrame(raf);
        canvas.remove();
        canvas = null;
      },
      resize,
    };
  }

  // The wand's trail: a pool of flakes emitted at the pointer. The loop only runs while some
  // flake is still alive, so a resting mouse costs nothing.
  function createTrail() {
    const MAX = 70;
    const LIFE_MS = 900;
    const sprite = flakeSprite(16);
    const pool = Array.from({ length: MAX }, () => ({ alive: false }));
    let canvas = null;
    let ctx = null;
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let lastX = null;
    let lastY = null;
    let next = 0;

    function emit(x, y) {
      const p = pool[next];
      next = (next + 1) % MAX;
      p.alive = true;
      p.x = x + (Math.random() - 0.5) * 6;
      p.y = y + (Math.random() - 0.5) * 6;
      p.vx = (Math.random() - 0.5) * 30;
      p.vy = 10 + Math.random() * 30;
      p.rot = Math.random() * Math.PI;
      p.spin = (Math.random() - 0.5) * 4;
      p.size = 6 + Math.random() * 8;
      p.age = 0;
    }

    function frame(t) {
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      for (const p of pool) {
        if (!p.alive) continue;
        p.age += dt * 1000;
        if (p.age >= LIFE_MS) {
          p.alive = false;
          continue;
        }
        alive++;
        p.vy += 40 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        const k = 1 - p.age / LIFE_MS;
        ctx.globalAlpha = k * 0.9;
        const s = p.size * (0.6 + 0.4 * k);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(sprite, -s / 2, -s / 2, s, s);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (alive > 0) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
        last = 0;
      }
    }

    function onMove(event) {
      if (event.pointerType && event.pointerType !== "mouse") return;
      const x = event.clientX;
      const y = event.clientY;
      // Spaced by distance, not by event: a fast flick leaves a line, a slow drift a few flakes.
      const dist = lastX === null ? 99 : Math.hypot(x - lastX, y - lastY);
      if (dist < 7) return;
      lastX = x;
      lastY = y;
      emit(x, y);
      if (dist > 30) emit(x, y);
      if (!raf) raf = requestAnimationFrame(frame);
    }

    function onLeave() {
      lastX = lastY = null;
    }

    function resize() {
      if (canvas) ({ ctx, w, h } = fitCanvas(canvas));
    }

    return {
      start() {
        if (canvas) return;
        canvas = makeCanvas("season-trail", document.body);
        resize();
        window.addEventListener("pointermove", onMove, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
      },
      stop() {
        if (!canvas) return;
        window.removeEventListener("pointermove", onMove);
        document.documentElement.removeEventListener("pointerleave", onLeave);
        cancelAnimationFrame(raf);
        raf = 0;
        for (const p of pool) p.alive = false;
        canvas.remove();
        canvas = null;
      },
      resize,
    };
  }

  // What each theme animates. A theme with no entry is static decor only; the next one adds a
  // line here (e.g. bats behind the content, a trident's sparks for the trail).
  const THEME_EFFECTS = {
    newyear: { background: createSnowfall, pointer: createTrail },
  };

  const spec = THEME_EFFECTS[themeId] || {};
  const background = spec.background ? spec.background() : null;
  const pointer = spec.pointer ? spec.pointer() : null;

  function applyEffects() {
    root.classList.toggle("season-on", decorOn());
    root.classList.toggle("season-motion", motionOn());
    const animate = motionOn() && !quiet;
    if (background) animate ? background.start() : background.stop();
    if (pointer) animate && finePointer.matches ? pointer.start() : pointer.stop();
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (background) background.resize();
      if (pointer) pointer.resize();
    }, 150);
  });
  reducedMotion.addEventListener("change", applyEffects);
  finePointer.addEventListener("change", applyEffects);

  // ------------------------------------------------------------------ the switch

  const toggle = document.querySelector(".season-toggle");
  const button = toggle && toggle.querySelector(".season-toggle__button");
  const panel = toggle && toggle.querySelector(".season-toggle__panel");
  const decorBox = toggle && toggle.querySelector("[data-season-decor]");
  const motionBox = toggle && toggle.querySelector("[data-season-motion]");

  function syncBoxes() {
    if (!decorBox || !motionBox) return;
    decorBox.checked = decorOn();
    motionBox.checked = motionOn();
    motionBox.disabled = !decorOn();
    if (button) button.setAttribute("aria-pressed", String(decorOn()));
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Private mode / blocked storage: the choice holds for this page and is simply not kept.
    }
    const csrf = toggle && toggle.dataset.csrf;
    if (!csrf) return; // guest: the browser is the only place a guest's choice lives
    root.dataset.seasonPref = pref;
    fetch("/season/decor", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ _csrf: csrf, pref }).toString(),
      credentials: "same-origin",
    }).catch(() => {
      // Saved in localStorage regardless; the account copy catches up on the next toggle.
    });
  }

  function onChoice() {
    pref = !decorBox.checked ? "off" : motionBox.checked ? "full" : "static";
    applyEffects();
    syncBoxes();
    persist();
  }

  function setOpen(open) {
    if (!panel || !button) return;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  if (button && panel && decorBox && motionBox) {
    syncBoxes();
    button.addEventListener("click", () => setOpen(panel.hidden));
    decorBox.addEventListener("change", onChoice);
    motionBox.addEventListener("change", onChoice);
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !toggle.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        setOpen(false);
        button.focus();
      }
    });
  }

  applyEffects();
})();
