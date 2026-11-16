// Seasonal theme: the viewer's switch in the nav, and the moving parts (falling snow or bats
// behind the content, the cursor's trail). The static decor is CSS (public/css/seasonal.css) and is already on screen
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

  // A soft glowing dot - the halloween trail's spark. One sprite per colour, stamped like the flake.
  function emberSprite(size, rgb) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const mid = size / 2;
    const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
    grad.addColorStop(0, "rgba(255,255,240,1)");
    grad.addColorStop(0.25, `rgba(${rgb},0.95)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  // One bat at the origin, wingspan 2*s, facing right. `flap` in [-1, 1] lifts or drops the
  // wing tips; drawn as paths every frame because the wings change shape.
  function drawBat(ctx, s, flap) {
    const tip = -s * 0.55 * flap;
    for (const side of [1, -1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.12);
      ctx.quadraticCurveTo(s * 0.45, -s * 0.3 + tip * 0.6, s, tip);
      ctx.quadraticCurveTo(s * 0.85, s * 0.12 + tip * 0.4, s * 0.68, s * 0.14 + tip * 0.3);
      ctx.quadraticCurveTo(s * 0.55, s * 0.05 + tip * 0.2, s * 0.44, s * 0.24 + tip * 0.15);
      ctx.quadraticCurveTo(s * 0.28, s * 0.1, 0, s * 0.26);
      ctx.closePath();
      ctx.fill();
      // ear
      ctx.beginPath();
      ctx.moveTo(s * 0.04, -s * 0.16);
      ctx.lineTo(s * 0.11, -s * 0.34);
      ctx.lineTo(s * 0.15, -s * 0.12);
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.ellipse(0, s * 0.05, s * 0.13, s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // A few bats crossing behind the content, each on its own wavering line. Few on purpose:
  // snow reads as weather at ninety flakes, bats read as a swarm long before that.
  function createBats() {
    const host = document.querySelector(".season-backdrop");
    if (!host) return null;
    let canvas = null;
    let ctx = null;
    let w = 0;
    let h = 0;
    let bats = [];
    let raf = 0;
    let last = 0;

    function spawn(bat, anywhere) {
      bat.dir = Math.random() < 0.5 ? 1 : -1;
      bat.size = 7 + Math.random() * 11;
      bat.x = anywhere ? Math.random() * w : bat.dir > 0 ? -bat.size * 2 : w + bat.size * 2;
      bat.baseY = 70 + Math.random() * Math.max(60, h * 0.7);
      bat.vx = (35 + Math.random() * 60) * bat.dir;
      bat.bob = 8 + Math.random() * 22;
      bat.phase = Math.random() * Math.PI * 2;
      bat.flapRate = 9 + Math.random() * 6;
      bat.flap = Math.random() * Math.PI * 2;
      bat.alpha = 0.3 + Math.random() * 0.35;
      return bat;
    }

    function seed() {
      const count = Math.max(4, Math.min(11, Math.round((w * h) / 140000)));
      bats = Array.from({ length: count }, () => spawn({}, true));
    }

    function frame(t) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#b9a2e8";
      for (const b of bats) {
        b.x += b.vx * dt;
        b.phase += dt * 1.3;
        b.flap += dt * b.flapRate;
        if ((b.dir > 0 && b.x - b.size * 2 > w) || (b.dir < 0 && b.x + b.size * 2 < 0)) spawn(b, false);
        const y = b.baseY + Math.sin(b.phase) * b.bob;
        ctx.globalAlpha = b.alpha;
        ctx.save();
        ctx.translate(b.x, y);
        ctx.rotate(Math.cos(b.phase) * 0.12 * b.dir);
        drawBat(ctx, b.size, Math.sin(b.flap));
        ctx.restore();
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

  // Shapes shared by the sprite makers below, in a 40x40 box centred on the origin - the same
  // outlines as the pictures in public/img/seasonal/, so a heart in the trail matches the
  // heart on the wallpaper.
  const SHAPES = {
    heart: "M0,18 C-14,8 -20,0 -20,-7 C-20,-14 -14,-18 -9,-18 C-5,-18 -2,-16 0,-12 C2,-16 5,-18 9,-18 C14,-18 20,-14 20,-7 C20,0 14,8 0,18 Z",
    maple: "M0,-20 L4,-11 L9,-14 L8,-5 L18,-8 L14,-1 L19,2 L9,6 L11,11 L2,8 L1,20 L-1,20 L-2,8 L-11,11 L-9,6 L-19,2 L-14,-1 L-18,-8 L-8,-5 L-9,-14 L-4,-11 Z",
    leaf: "M0,-20 C11,-12 11,8 0,20 C-11,8 -11,-12 0,-20 Z",
    star: "M0,-20 L5.9,-8.1 L19,-6.2 L9.5,3.1 L11.8,16.2 L0,10 L-11.8,16.2 L-9.5,3.1 L-19,-6.2 L-5.9,-8.1 Z",
  };

  function spriteCanvas(size, draw) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.translate(size / 2, size / 2);
    draw(g, size / 2);
    return c;
  }

  // One of SHAPES filled in one colour; `vein` adds the midrib a leaf or petal needs to read
  // as one at a dozen pixels.
  function shapeSprite(size, shape, fill, vein) {
    return spriteCanvas(size, (g, half) => {
      const k = (half - 1) / 20;
      g.scale(k, k);
      g.fillStyle = fill;
      g.fill(new Path2D(SHAPES[shape]));
      if (vein) {
        g.strokeStyle = vein;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(0, -15);
        g.lineTo(0, 18);
        g.stroke();
      }
    });
  }

  function balloonSprite(size, fill) {
    return spriteCanvas(size, (g, half) => {
      const r = half * 0.55;
      g.strokeStyle = "rgba(230,225,245,0.8)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, r * 1.2);
      g.quadraticCurveTo(-r * 0.3, half * 0.75, r * 0.1, half - 1);
      g.stroke();
      g.fillStyle = fill;
      g.beginPath();
      g.ellipse(0, -half * 0.25, r, r * 1.25, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.4)";
      g.beginPath();
      g.ellipse(-r * 0.4, -half * 0.5, r * 0.22, r * 0.38, -0.4, 0, Math.PI * 2);
      g.fill();
    });
  }

  function bubbleSprite(size) {
    return spriteCanvas(size, (g, half) => {
      const r = half - 1.5;
      g.fillStyle = "rgba(170,225,255,0.10)";
      g.strokeStyle = "rgba(200,240,255,0.85)";
      g.lineWidth = Math.max(1, size / 22);
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.beginPath();
      g.arc(0, 0, r * 0.65, Math.PI * 1.1, Math.PI * 1.45);
      g.stroke();
    });
  }

  function confettiSprite(size, fill) {
    return spriteCanvas(size, (g, half) => {
      g.fillStyle = fill;
      g.fillRect(-half * 0.35, -half * 0.8, half * 0.7, half * 1.6);
    });
  }

  // A field of sprites drifting across the backdrop: down (petals, leaves) or up (hearts,
  // balloons, bubbles). Same lifecycle as the snowfall; `tumble` flips a sprite edge-on and
  // back, which is what makes a leaf look like a leaf rather than a sticker.
  function createDrift({ sprites, up = false, speed = [14, 40], size = [10, 22], sway = [6, 20],
    spin = 0.8, tumble = false, alpha = [0.25, 0.6], density = 22000, min = 14, max = 60 }) {
    const host = document.querySelector(".season-backdrop");
    if (!host) return null;
    const pick = (range) => range[0] + Math.random() * (range[1] - range[0]);
    let images = null;
    let canvas = null;
    let ctx = null;
    let w = 0;
    let h = 0;
    let items = [];
    let raf = 0;
    let last = 0;

    function respawn(it, anywhere) {
      it.size = pick(size);
      it.x = Math.random() * w;
      it.y = anywhere ? Math.random() * h : up ? h + it.size : -it.size;
      it.vy = pick(speed) * (up ? -1 : 1);
      it.phase = Math.random() * Math.PI * 2;
      it.sway = pick(sway);
      it.rot = Math.random() * Math.PI * 2;
      it.spin = (Math.random() - 0.5) * 2 * spin;
      it.alpha = pick(alpha);
      it.img = images[Math.floor(Math.random() * images.length)];
      return it;
    }

    function seed() {
      const count = Math.max(min, Math.min(max, Math.round((w * h) / density)));
      items = Array.from({ length: count }, () => respawn({}, true));
    }

    function frame(t) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      for (const it of items) {
        it.y += it.vy * dt;
        it.phase += dt * 0.9;
        it.rot += it.spin * dt;
        if (up ? it.y + it.size < 0 : it.y - it.size > h) respawn(it, false);
        const x = it.x + Math.sin(it.phase) * it.sway;
        ctx.globalAlpha = it.alpha;
        ctx.save();
        ctx.translate(x, it.y);
        ctx.rotate(it.rot);
        if (tumble) ctx.scale(Math.cos(it.phase * 2.2), 1);
        ctx.drawImage(it.img, -it.size / 2, -it.size / 2, it.size, it.size);
        ctx.restore();
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
        if (!images) images = sprites();
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

  // A clown slides in from a screen edge, hangs about for a moment and ducks back out. Every
  // 12-30 s, one at a time, from the bottom, left or right edge - never the top, where the bar is.
  function createClownPops() {
    let timer = 0;
    let running = false;

    function popOne() {
      const el = document.createElement("div");
      el.className = "season-popclown";
      el.setAttribute("aria-hidden", "true");
      const edge = ["bottom", "bottom", "left", "right"][Math.floor(Math.random() * 4)];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (edge === "bottom") {
        el.style.left = `${Math.round(40 + Math.random() * Math.max(0, vw - 200))}px`;
        el.style.bottom = "0";
      } else {
        // Turned a quarter, the 120x90 box is 90 wide: shifting it by -15px puts its
        // (now sideways) bottom exactly on the edge.
        el.style.top = `${Math.round(90 + Math.random() * Math.max(0, vh - 260))}px`;
        el.style[edge] = "-15px";
        el.style.setProperty("--season-pop-turn", edge === "left" ? "90deg" : "-90deg");
      }
      el.addEventListener("animationend", () => el.remove(), { once: true });
      document.body.appendChild(el);
    }

    function schedule() {
      timer = setTimeout(() => {
        if (!running) return;
        if (!document.hidden) popOne();
        schedule();
      }, 12000 + Math.random() * 18000);
    }

    return {
      start() {
        if (running) return;
        running = true;
        timer = setTimeout(() => {
          if (running) popOne();
          schedule();
        }, 2500);
      },
      stop() {
        running = false;
        clearTimeout(timer);
        document.querySelectorAll(".season-popclown").forEach((el) => el.remove());
      },
      resize() {},
    };
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

  // The wand's trail: a pool of particles emitted at the pointer. The loop only runs while some
  // particle is still alive, so a resting mouse costs nothing. `sprites` is drawn from at random;
  // `gravity` and `rise` decide whether the trail falls like snow or floats up like sparks.
  function createTrail({ sprites, gravity = 40, rise = false, burstOnClick = 0 } = {}) {
    const MAX = 70;
    const LIFE_MS = 900;
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

    function emit(x, y, power = 1) {
      const p = pool[next];
      next = (next + 1) % MAX;
      p.alive = true;
      p.x = x + (Math.random() - 0.5) * 6;
      p.y = y + (Math.random() - 0.5) * 6;
      p.vx = (Math.random() - 0.5) * 30 * power;
      p.vy = (10 + Math.random() * 30) * (rise ? -1 : 1) * (power > 1 ? -(0.5 + Math.random()) * power * 0.6 : 1);
      p.sprite = sprites[Math.floor(Math.random() * sprites.length)];
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
        p.vy += gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        const k = 1 - p.age / LIFE_MS;
        ctx.globalAlpha = k * 0.9;
        const s = p.size * (0.6 + 0.4 * k);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(p.sprite, -s / 2, -s / 2, s, s);
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

    // A handful thrown up and out from the click point (confetti on April 1).
    function onDown(event) {
      if (event.pointerType && event.pointerType !== "mouse") return;
      for (let i = 0; i < burstOnClick; i++) emit(event.clientX, event.clientY, 5);
      if (!raf) raf = requestAnimationFrame(frame);
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
        if (burstOnClick) window.addEventListener("pointerdown", onDown, { passive: true });
        document.documentElement.addEventListener("pointerleave", onLeave);
      },
      stop() {
        if (!canvas) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerdown", onDown);
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

  // April 1: the brand and the tab title join in. A decoration, not motion - it follows the
  // decor switch only, and is put back exactly when the viewer switches the decor off.
  function createClownLabels() {
    const brands = Array.from(document.querySelectorAll("[data-season-brand]"));
    const originals = brands.map((el) => el.textContent);
    const title = document.title;
    return {
      apply() {
        brands.forEach((el, i) => {
          el.textContent = /^Chat/.test(originals[i]) ? originals[i].replace(/^Chat/, "Clown") : `\u{1F921} ${originals[i]}`;
        });
        document.title = `\u{1F921} ${title}`;
      },
      revert() {
        brands.forEach((el, i) => { el.textContent = originals[i]; });
        document.title = title;
      },
    };
  }

  const AUTUMN = ["#e8641c", "#d23a1c", "#f2a81c", "#b8461c", "#e8c21c"];
  const CONFETTI = ["#e8202a", "#ffd23a", "#2f6fd6", "#2fbf5a", "#ff5a1f", "#b05be8"];

  // What each theme animates. A theme with no entry is static decor only. `background` runs
  // behind the content, `pointer` follows the mouse, `extra` is anything else that moves, and
  // `decor` is a non-moving change the script has to make itself.
  const THEME_EFFECTS = {
    newyear: {
      background: createSnowfall,
      pointer: () => createTrail({ sprites: [flakeSprite(16)] }),
    },
    halloween: {
      background: createBats,
      pointer: () => createTrail({
        sprites: [emberSprite(16, "255,150,40"), emberSprite(16, "190,120,255"), emberSprite(16, "140,255,110")],
        gravity: -25,
        rise: true,
      }),
    },
    valentine: {
      background: () => createDrift({
        sprites: () => ["#ff4d7d", "#ff9db8", "#e8174f", "#ffc2d4"].map((c) => shapeSprite(32, "heart", c)),
        up: true, speed: [12, 30], size: [8, 20], spin: 0.4, alpha: [0.2, 0.5], density: 30000, min: 10, max: 40,
      }),
      pointer: () => createTrail({ sprites: ["#ff4d7d", "#ff9db8", "#e8174f"].map((c) => shapeSprite(16, "heart", c)) }),
    },
    aprilfools: {
      background: () => createDrift({
        sprites: () => CONFETTI.map((c) => balloonSprite(48, c)),
        up: true, speed: [18, 40], size: [26, 44], spin: 0, sway: [8, 18], alpha: [0.25, 0.5], density: 60000, min: 6, max: 18,
      }),
      pointer: () => createTrail({ sprites: CONFETTI.map((c) => confettiSprite(16, c)), gravity: 120, burstOnClick: 18 }),
      extra: createClownPops,
      decor: createClownLabels,
    },
    march8: {
      background: () => createDrift({
        sprites: () => ["#ffb0cf", "#ff7fb0", "#ffe4ef", "#ffd21f"].map((c) => shapeSprite(24, "leaf", c, "rgba(0,0,0,0.12)")),
        speed: [16, 34], size: [8, 15], tumble: true, alpha: [0.3, 0.6], density: 26000,
      }),
      pointer: () => createTrail({ sprites: ["#ffb0cf", "#ff7fb0", "#ffd21f"].map((c) => shapeSprite(16, "leaf", c)), gravity: 30 }),
    },
    summer: {
      background: () => createDrift({
        sprites: () => [bubbleSprite(40)],
        up: true, speed: [14, 32], size: [10, 30], spin: 0, alpha: [0.25, 0.55], density: 34000, min: 10, max: 36,
      }),
      pointer: () => createTrail({ sprites: [bubbleSprite(20)], gravity: -20, rise: true }),
    },
    september: {
      background: () => createDrift({
        sprites: () => [
          ...AUTUMN.map((c) => shapeSprite(32, "maple", c, "rgba(0,0,0,0.18)")),
          ...AUTUMN.slice(0, 3).map((c) => shapeSprite(32, "leaf", c, "rgba(0,0,0,0.18)")),
        ],
        speed: [20, 46], size: [12, 24], spin: 1.2, tumble: true, alpha: [0.3, 0.65], density: 30000, min: 10, max: 45,
      }),
      pointer: () => createTrail({ sprites: AUTUMN.map((c) => shapeSprite(16, "maple", c)), gravity: 45 }),
    },
  };

  const spec = THEME_EFFECTS[themeId] || {};
  const background = spec.background ? spec.background() : null;
  const pointer = spec.pointer ? spec.pointer() : null;
  const extra = spec.extra ? spec.extra() : null;
  const decor = spec.decor ? spec.decor() : null;
  let decorApplied = false;

  function applyEffects() {
    root.classList.toggle("season-on", decorOn());
    root.classList.toggle("season-motion", motionOn());
    const animate = motionOn() && !quiet;
    if (background) animate ? background.start() : background.stop();
    if (pointer) animate && finePointer.matches ? pointer.start() : pointer.stop();
    if (extra) animate ? extra.start() : extra.stop();
    if (decor && decorOn() !== decorApplied) {
      decorApplied = decorOn();
      decorApplied ? decor.apply() : decor.revert();
    }
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
