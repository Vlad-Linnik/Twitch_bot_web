// The owner's wheel over a section's suggestions (views/mediaWheel.ejs). The chances come from
// lib/wheelMath.js (served as /js/shared/wheel-math.js): the plain wheel draws each option with a
// sector of its weight; the elimination wheel draws the sector each option is eliminated with,
// proportional to the weight of everybody else, so the last one left wins with the plain wheel's
// chance. The spin's outcome is decided first, by crypto.getRandomValues, and the animation only
// lands the pointer inside that sector - the drawing never decides anything.
//
// Animation model: every option has a DISPLAYED share of the wheel (`frac`) that eases towards its
// real one whenever the wheel changes - a mode switch morphs the sectors, a ticked film grows in,
// an eliminated one collapses to nothing while the rest close the gap. A spin always starts from
// settled shares, so the sector the pointer stops in is exactly the one that was drawn.
//
// Kept per channel in localStorage: the choice of films, weights, mode, spin length, the auto
// switch, "hide the eliminated" and the centre emote. What has been eliminated is not - a reload
// starts a new game.
(function () {
  "use strict";
  const root = document.querySelector("[data-wheel]");
  const dataEl = document.getElementById("wheel-data");
  if (!root || !dataEl || !window.WheelMath) return;
  const M = window.WheelMath;
  const data = JSON.parse(dataEl.textContent);
  const L = data.labels;
  const STORE_KEY = "mediaWheel:" + data.channel;
  const MAX_WEIGHT = 1e6;
  const TAU = Math.PI * 2;
  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (sel) => root.querySelector(sel);
  const canvas = $("[data-wheel-canvas]");
  const ctx = canvas.getContext("2d");
  const stage = $("[data-wheel-stage]");
  const pointer = $("[data-wheel-pointer]");
  const hub = $("[data-wheel-hub]");
  const hubEmote = $("[data-wheel-emote]");
  const hubText = $("[data-wheel-hub-text]");
  const overlay = $("[data-wheel-overlay]");
  const spinBtn = $("[data-wheel-spin]");
  const resetBtn = $("[data-wheel-reset]");
  const listEl = $("[data-wheel-list]");
  const countEl = $("[data-wheel-count]");
  const durationEl = $("[data-wheel-duration]");
  const autoWrap = $("[data-wheel-auto-wrap]");
  const autoEl = $("[data-wheel-auto]");
  const hideOutEl = $("[data-wheel-hide-out]");
  const pickTopEl = $("[data-wheel-pick-top]");
  const pickAboveEl = $("[data-wheel-pick-above]");

  // --- state -----------------------------------------------------------------------------------
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (_) { saved = {}; }
  const savedWeights = saved.weights || {};
  const savedOff = new Set(saved.off || []);
  const options = data.options.map((o, i) => ({
    ...o,
    on: !savedOff.has(o.id),
    weight: 1,
    color: colorOf(i),
    frac: 0, from: 0, to: 0, // displayed share of the wheel, and the ease it is on
    hl: 0, // displayed highlight 0..1
    img: null,
    row: null,
  }));
  let mode = saved.mode === "elimination" ? "elimination" : "plain";
  // Where the weights come from: "equal", "votes" (1 + the counted score, a downvoted card keeping
  // the floor of 1 - voting it down is "not now", not "never"), or "custom" once a weight is edited
  // by hand. Only custom weights are stored; the other two are recomputed on every visit, so "by
  // votes" follows the voting rather than a snapshot of it.
  let weightMode = ["equal", "votes", "custom"].includes(saved.weightMode) ? saved.weightMode : "equal";
  const weightOf = (o) => (weightMode === "votes" ? 1 + Math.max(0, o.score) : 1);
  for (const o of options) {
    o.weight = weightMode === "custom" && Number.isFinite(savedWeights[o.id]) ? savedWeights[o.id] : weightOf(o);
  }
  durationEl.value = String(clampDuration(saved.duration ?? 6));
  autoEl.checked = Boolean(saved.auto);
  hideOutEl.checked = Boolean(saved.hideOut);
  if (Number.isInteger(saved.pickTop)) pickTopEl.value = String(saved.pickTop);
  if (Number.isInteger(saved.pickAbove)) pickAboveEl.value = String(saved.pickAbove);
  let emote = saved.emote && typeof saved.emote.url === "string" ? saved.emote : null;

  const eliminated = []; // option ids in the order they dropped out
  let phase = "idle"; // idle | spinning | dropping | won
  let rotation = 0; // radians, clockwise
  let spinAnim = null; // {from, to, t0, ms, onDone}
  let morph = null; // {t0, ms}
  let hoverId = null;
  let focusId = null; // the sector the pointer just stopped on
  let lastPointerSector = null;
  let running = false;
  let lastFrame = 0;
  let autoTimer = null;

  function intOf(input, fallback) {
    const n = Math.trunc(Number(input.value));
    return Number.isFinite(n) ? n : fallback;
  }

  function clampDuration(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(120, Math.max(1, Math.round(n * 2) / 2)) : 6;
  }

  function save() {
    const weights = {};
    const off = [];
    for (const o of options) {
      if (weightMode === "custom" && o.weight !== 1) weights[o.id] = o.weight;
      if (!o.on) off.push(o.id);
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode, weightMode, duration: clampDuration(durationEl.value), auto: autoEl.checked, hideOut: hideOutEl.checked, weights, off, emote,
        pickTop: intOf(pickTopEl, 10), pickAbove: intOf(pickAboveEl, 0),
      }));
    } catch (_) { /* private mode, full storage: the wheel still works, it just forgets */ }
  }

  // Golden-angle hues: neighbours never share a colour, however many options there are.
  function colorOf(i) {
    return `hsl(${Math.round((i * 137.508) % 360)} 65% 50%)`;
  }

  const isOut = (o) => eliminated.includes(o.id);
  const inGame = (o) => o.on && o.weight > 0 && !isOut(o);
  const onWheel = () => options.filter(inGame);
  const finished = () => mode === "elimination" && eliminated.length > 0 && onWheel().length <= 1;
  const busy = () => phase === "spinning" || phase === "dropping";
  const locked = () => busy() || eliminated.length > 0; // the list and the mode are frozen mid-game

  function uniform() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53; // 53 random bits -> [0, 1)
  }

  // --- shares and their easing -----------------------------------------------------------------
  function targetFracs() {
    const live = onWheel();
    const s = M.sectorsFor(mode, live.map((o) => o.weight));
    const total = s.reduce((a, b) => a + b, 0);
    const byId = new Map(live.map((o, i) => [o.id, total > 0 ? s[i] / total : 1 / live.length]));
    return options.map((o) => byId.get(o.id) || 0);
  }

  function retarget(ms) {
    const t = targetFracs();
    options.forEach((o, i) => { o.from = o.frac; o.to = t[i]; });
    morph = reducedMotion || !ms ? null : { t0: performance.now(), ms };
    if (!morph) options.forEach((o) => { o.frac = o.to; });
    kick();
  }

  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  // The spin's speed rises for the first 8% of the time, then dies away as (1 - t)^3 - a soft
  // start and a long, readable slow-down. Position is the integral, normalised to 0..1.
  function spinProgress(t) {
    const a = 0.08;
    const total = a / 2 + (1 - a) / 4;
    if (t < a) return (t * t) / (2 * a) / total;
    const u = (1 - t) / (1 - a);
    return (a / 2 + ((1 - a) / 4) * (1 - u * u * u * u)) / total;
  }

  // --- frame loop ------------------------------------------------------------------------------
  function kick() {
    if (running) return;
    running = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    let more = false;

    if (morph) {
      const k = Math.min(1, (now - morph.t0) / morph.ms);
      const e = easeInOut(k);
      for (const o of options) o.frac = o.from + (o.to - o.from) * e;
      if (k < 1) more = true;
      else morph = null;
    }

    if (spinAnim) {
      const k = Math.min(1, (now - spinAnim.t0) / spinAnim.ms);
      rotation = spinAnim.from + (spinAnim.to - spinAnim.from) * spinProgress(k);
      if (k < 1) more = true;
      else {
        rotation = spinAnim.to % TAU;
        const done = spinAnim.onDone;
        spinAnim = null;
        done();
      }
      flickOnEdge();
    }

    for (const o of options) {
      const want = o.id === hoverId || o.id === focusId ? 1 : 0;
      o.hl += (want - o.hl) * Math.min(1, dt * 14);
      if (Math.abs(want - o.hl) > 0.005) more = true;
      else o.hl = want;
    }

    draw();
    hubEmote.style.transform = `rotate(${rotation}rad)`;
    if (more || morph || spinAnim) requestAnimationFrame(frame);
    else running = false;
  }

  // The option whose sector is at share-position p (0..1 clockwise from the wheel's own zero).
  function optionAt(p) {
    let at = 0;
    for (const o of options) {
      if (!(o.frac > 0)) continue;
      at += o.frac;
      if (p < at) return o;
    }
    return null;
  }

  // The pointer flicks back each time a sector edge passes under it.
  function flickOnEdge() {
    const p = (((-rotation / TAU) % 1) + 1) % 1;
    const o = optionAt(p);
    const id = o ? o.id : null;
    if (id === lastPointerSector) return;
    lastPointerSector = id;
    if (reducedMotion) return;
    pointer.classList.add("is-flicked");
    pointer.style.setProperty("--flick", "-24deg");
    setTimeout(() => {
      pointer.classList.remove("is-flicked");
      pointer.style.removeProperty("--flick");
    }, 45);
  }

  // --- drawing ---------------------------------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (!size) return;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fitText(text, maxWidth) {
    if (maxWidth <= 0) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo ? text.slice(0, lo) + "…" : "";
  }

  function sectorPath(r, a0, a1) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, a0, a1);
    ctx.closePath();
  }

  // The cover, its top at the rim and its long side along the sector's middle, scaled so that it
  // fills the sector's width at the rim.
  function drawPoster(img, r, theta) {
    let w = theta >= Math.PI ? 2 * r : Math.max(r * 0.7, 2 * r * Math.sin(theta / 2) * 1.08);
    let h = w * 1.5;
    if (h < r * 1.04) { h = r * 1.04; w = h / 1.5; }
    if (theta >= Math.PI) { h = Math.max(h, 2 * r); w = Math.max(w, h / 1.5); }
    // Cover-crop whatever the picture's own proportions are.
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max(w / iw, h / ih);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(img, (iw - sw) / 2, 0, sw, sh, -w / 2, -r, w, h);
  }

  function draw() {
    const size = canvas.clientWidth;
    if (!size) return;
    const c = size / 2;
    const r = c - 10;
    const hubR = size * 0.11;
    ctx.clearRect(0, 0, size, size);

    // The rim behind everything.
    ctx.beginPath();
    ctx.arc(c, c, r + 6, 0, TAU);
    ctx.fillStyle = "#0c0a09";
    ctx.fill();

    const shown = options.filter((o) => o.frac > 0.0004);
    if (!shown.length) {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TAU);
      ctx.fillStyle = "#1c1917";
      ctx.fill();
      return;
    }
    const maxHl = Math.max(0, ...shown.map((o) => o.hl));
    const base = -Math.PI / 2 + rotation; // angle 0 = the pointer at the top
    let at = 0;
    const spans = [];
    for (const o of options) {
      if (!(o.frac > 0.0004)) { at += o.frac > 0 ? o.frac : 0; continue; }
      const a0 = base + at * TAU;
      const a1 = a0 + o.frac * TAU;
      at += o.frac;
      spans.push({ o, a0, a1 });
    }

    const single = spans.length === 1;
    for (const { o, a0, a1 } of spans) {
      const mid = (a0 + a1) / 2;
      const theta = a1 - a0;
      const pop = single ? 0 : o.hl * Math.min(10, size * 0.018);
      ctx.save();
      ctx.translate(c + Math.cos(mid) * pop, c + Math.sin(mid) * pop);
      if (single) { ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); } else sectorPath(r, a0, a1);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = o.color;
      ctx.fill();
      if (o.img && o.img.complete && o.img.naturalWidth) {
        ctx.save();
        // A lone film fills the whole wheel, upright; a sector's cover runs along its middle.
        if (single) ctx.translate(0, -r * 0.5);
        else ctx.rotate(mid + Math.PI / 2);
        drawPoster(o.img, r, single ? TAU : theta);
        ctx.restore();
        // A wash of the option's colour and a shade, so the label reads on any cover.
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = o.color;
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
        ctx.globalAlpha = 1;
        const g = ctx.createRadialGradient(0, 0, hubR, 0, 0, r);
        g.addColorStop(0, "rgba(0,0,0,.55)");
        g.addColorStop(0.55, "rgba(0,0,0,.15)");
        g.addColorStop(1, "rgba(0,0,0,.35)");
        ctx.fillStyle = g;
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
      }
      // Everything else dims while one sector is highlighted.
      const dim = 0.55 * maxHl * (1 - o.hl);
      if (dim > 0.01) {
        ctx.fillStyle = `rgba(0,0,0,${dim})`;
        ctx.fillRect(-r, -r, 2 * r, 2 * r);
      }
      ctx.restore();
      // The colour band on the rim - the same colour as the dot in the list.
      ctx.beginPath();
      ctx.arc(0, 0, r - 3 - o.hl * 2, single ? 0 : a0, single ? TAU : a1);
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 6 + o.hl * 4;
      ctx.stroke();
      if (!single) {
        sectorPath(r, a0, a1);
        ctx.strokeStyle = "rgba(12,10,9,.8)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Labels on top: along each sector's middle, from the rim inwards, sized to the sector.
    for (const { o, a0, a1 } of spans) {
      const theta = a1 - a0;
      const arcLen = theta * r * 0.62;
      const fontPx = Math.min(17, arcLen * 0.75, size / 24);
      if (fontPx < 8 || single) continue; // a lone film is named by the overlay
      const mid = (a0 + a1) / 2;
      const pop = single ? 0 : o.hl * Math.min(10, size * 0.018);
      ctx.save();
      ctx.translate(c + Math.cos(mid) * pop, c + Math.sin(mid) * pop);
      ctx.rotate(single ? -Math.PI / 2 + rotation : mid);
      ctx.globalAlpha = 1 - 0.5 * maxHl * (1 - o.hl);
      ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.9)";
      ctx.shadowBlur = 6;
      const text = fitText(o.title, r - hubR - 34);
      if (text) ctx.fillText(text, r - 18, 0);
      ctx.restore();
    }
  }

  // --- the list --------------------------------------------------------------------------------
  function pct(x) {
    if (!(x > 0)) return "0%";
    const v = x * 100;
    return (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)) + "%";
  }

  function buildRows() {
    for (const o of options) {
      const li = document.createElement("li");
      li.className = "media-wheel-row flex items-center gap-2 rounded-md px-2 py-1.5";
      li.style.setProperty("--row-color", o.color);

      const swatch = document.createElement("span");
      swatch.className = "shrink-0 w-2.5 h-2.5 rounded-full";
      swatch.style.background = o.color;

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "shrink-0 accent-(--sec-accent)";
      box.setAttribute("aria-label", o.title);
      box.addEventListener("change", () => {
        o.on = box.checked;
        changed(450);
      });

      const name = document.createElement("a");
      name.href = `${data.base}/${encodeURIComponent(o.id)}`;
      name.target = "_blank";
      name.rel = "noopener";
      name.className = "min-w-0 flex-1 truncate text-sm text-stone-200 hover:text-(--sec-accent-soft)";
      const nameText = document.createElement("span");
      nameText.className = "media-wheel-strike";
      nameText.textContent = o.title + (o.year ? ` (${o.year})` : "");
      name.append(nameText);
      name.title = [nameText.textContent, o.status === "accepted" ? L.planned : "", L.votes.replace("{{n}}", o.score)].filter(Boolean).join(" · ");

      const weight = document.createElement("input");
      weight.type = "number";
      weight.min = "0";
      weight.step = "any";
      weight.max = String(MAX_WEIGHT);
      weight.setAttribute("aria-label", `${L.weight}: ${o.title}`);
      weight.className = "shrink-0 w-14 rounded bg-stone-950/60 border border-stone-700 text-right text-sm tabular-nums text-stone-100 px-1.5 py-0.5 focus:outline-none focus:border-(--sec-accent) disabled:opacity-50";
      weight.addEventListener("change", () => {
        const v = Number(weight.value);
        o.weight = Number.isFinite(v) && v > 0 ? Math.min(v, MAX_WEIGHT) : 0;
        if (o.weight !== weightOf(o)) weightMode = "custom";
        changed(450);
      });

      const chance = document.createElement("span");
      chance.className = "shrink-0 w-12 text-right text-xs tabular-nums text-stone-400";
      chance.title = L.chance;

      li.append(swatch, box, name, weight, chance);
      li.addEventListener("mouseenter", () => setHover(o.id));
      li.addEventListener("mouseleave", () => setHover(null));
      listEl.append(li);
      o.row = { li, box, weight, chance };
    }
  }

  function updateRows() {
    const live = onWheel();
    const chances = M.winChances(live.map((o) => o.weight));
    const chanceOf = new Map(live.map((o, i) => [o.id, chances[i]]));
    const frozen = locked();
    for (const o of options) {
      const { li, box, weight, chance } = o.row;
      const out = isOut(o);
      box.checked = o.on;
      box.disabled = frozen;
      weight.disabled = frozen;
      if (document.activeElement !== weight) weight.value = String(o.weight);
      chance.textContent = out ? "—" : o.on && o.weight > 0 ? pct(chanceOf.get(o.id) || 0) : "";
      li.classList.toggle("is-out", out);
      li.classList.toggle("is-gone", out && hideOutEl.checked);
      li.classList.toggle("opacity-50", !out && !(o.on && o.weight > 0));
    }
    const n = live.length;
    countEl.textContent = mode === "elimination" && eliminated.length ? L.left.replace("{{n}}", n) : L.onWheel.replace("{{n}}", n);
  }

  function setHover(id) {
    if (hoverId === id) return;
    hoverId = id;
    for (const o of options) o.row.li.classList.toggle("is-hover", o.id === id);
    kick();
  }

  // --- controls --------------------------------------------------------------------------------
  function syncControls() {
    for (const b of root.querySelectorAll("[data-wheel-mode]")) {
      b.setAttribute("aria-checked", String(b.dataset.wheelMode === mode));
      b.disabled = locked();
    }
    for (const b of root.querySelectorAll("[data-wheel-preset]")) {
      b.setAttribute("aria-checked", String(b.dataset.wheelPreset === weightMode));
      b.disabled = locked();
    }
    $("[data-wheel-custom]").hidden = weightMode !== "custom";
    for (const b of root.querySelectorAll("[data-wheel-all], [data-wheel-pick]")) b.disabled = locked();
    pickTopEl.disabled = locked();
    pickAboveEl.disabled = locked();
    autoWrap.hidden = mode !== "elimination";
    resetBtn.disabled = busy() || !(eliminated.length || phase === "won");
    const live = onWheel().length;
    const canSpin = !busy() && (finished() || (live > 0 && (mode === "plain" || live >= 2)));
    spinBtn.disabled = !canSpin;
    hub.disabled = !canSpin;
    spinBtn.textContent = finished() ? L.again : spinBtn.dataset.label;
  }

  function syncHub() {
    hubEmote.hidden = !emote;
    hubText.hidden = Boolean(emote);
    if (emote && hubEmote.getAttribute("src") !== emote.url) hubEmote.src = emote.url;
    const preview = root.querySelector("[data-wheel-emote-preview]");
    preview.hidden = !emote;
    if (emote) { preview.src = emote.url; preview.alt = emote.name; }
  }

  function changed(ms) {
    if (phase === "won" && mode === "plain") { phase = "idle"; hideOverlay(); }
    save();
    retarget(ms);
    updateRows();
    syncControls();
  }

  // --- overlay over the centre -----------------------------------------------------------------
  function showOverlay(node) {
    overlay.classList.remove("is-shown");
    overlay.textContent = "";
    overlay.append(node);
    void overlay.offsetWidth; // restart the transition
    overlay.classList.add("is-shown");
  }

  function hideOverlay() {
    overlay.classList.remove("is-shown");
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function outCard(o) {
    const card = el("div", "media-wheel-overlay-card");
    card.append(el("p", "text-xs uppercase tracking-widest text-red-300/90", L.out));
    const t = el("p", "mt-1 text-xl sm:text-2xl font-extrabold text-stone-100 leading-tight");
    t.append(el("span", "media-wheel-out-title", o.title));
    card.append(t);
    return card;
  }

  function winnerCard(o) {
    const card = el("div", "media-wheel-overlay-card is-winner flex flex-col items-center");
    if (o.posterUrl) {
      const img = el("img", "w-16 sm:w-20 aspect-[2/3] object-cover rounded-md mb-2 shadow-lg shadow-black/60");
      img.src = o.posterUrl;
      img.alt = "";
      card.append(img);
    }
    card.append(el("p", "text-xs uppercase tracking-widest text-(--sec-accent-strong)", L.winner));
    card.append(el("p", "mt-1 text-xl sm:text-2xl font-extrabold text-stone-100 leading-tight", o.title + (o.year ? ` (${o.year})` : "")));
    const actions = el("div", "mt-3 flex flex-wrap justify-center gap-2");
    const open = el("a", "px-3 py-1 rounded-full bg-(--sec-accent) text-stone-950 text-sm font-semibold hover:brightness-110", L.open);
    open.href = `${data.base}/${encodeURIComponent(o.id)}`;
    open.dataset.interactive = "";
    const again = el("button", "px-3 py-1 rounded-full ring-1 ring-stone-600 text-stone-200 text-sm hover:ring-(--sec-accent)", L.again);
    again.type = "button";
    again.dataset.interactive = "";
    again.addEventListener("click", () => (mode === "elimination" ? reset() : dismissWinner()));
    actions.append(open, again);
    card.append(actions);
    return card;
  }

  function dismissWinner() {
    phase = "idle";
    focusId = null;
    hideOverlay();
    syncControls();
    kick();
  }

  // --- spinning --------------------------------------------------------------------------------
  function spin() {
    clearTimeout(autoTimer);
    if (busy()) return;
    if (finished()) return reset();
    if (phase === "won") { phase = "idle"; hideOverlay(); }
    const live = onWheel();
    if (!live.length || (mode === "elimination" && live.length < 2)) return;

    // Settle the shares first: the pointer must land in the sector as it will be drawn.
    if (morph) { morph = null; for (const o of options) o.frac = o.to; }
    const s = M.sectorsFor(mode, live.map((o) => o.weight));
    const k = M.pickIndex(s, uniform());
    if (k < 0) return;
    const picked = live[k];
    let start = 0;
    for (const o of options) {
      if (o === picked) break;
      start += o.frac;
    }
    // A point well inside the sector, never on its edge, so the pointer visibly rests in it.
    const f = start + picked.frac * (0.1 + 0.8 * uniform());
    // The point at share f sits at angle rotation + 2πf from the top; it must end at 0 (mod 2π).
    const seconds = clampDuration(durationEl.value);
    const turns = reducedMotion ? 1 : Math.max(2, Math.round(seconds * 1.1));
    const from = rotation;
    let to = -f * TAU;
    to += Math.ceil((from - to) / TAU) * TAU + turns * TAU;

    phase = "spinning";
    focusId = null;
    hideOverlay();
    syncControls();
    updateRows();
    spinAnim = { from, to, t0: performance.now(), ms: seconds * 1000, onDone: () => landed(picked) };
    kick();
  }

  function landed(o) {
    focusId = o.id;
    if (mode !== "elimination") {
      phase = "won";
      showOverlay(winnerCard(o));
      syncControls();
      return;
    }
    // Elimination: name it over the wheel, then collapse its sector and strike it in the list.
    phase = "dropping";
    showOverlay(outCard(o));
    syncControls();
    setTimeout(() => {
      eliminated.push(o.id);
      focusId = null;
      o.row.li.classList.add("is-out-new");
      setTimeout(() => o.row.li.classList.remove("is-out-new"), 800);
      retarget(900);
      updateRows();
      setTimeout(afterDrop, 1500);
    }, 650);
  }

  function afterDrop() {
    if (finished()) {
      const last = onWheel()[0];
      phase = "won";
      focusId = last ? last.id : null;
      if (last) showOverlay(winnerCard(last));
      syncControls();
      kick();
      return;
    }
    phase = "idle";
    hideOverlay();
    syncControls();
    if (autoEl.checked) autoTimer = setTimeout(spin, 450);
  }

  function reset() {
    if (busy()) return;
    clearTimeout(autoTimer);
    eliminated.length = 0;
    phase = "idle";
    focusId = null;
    hideOverlay();
    retarget(800);
    updateRows();
    syncControls();
  }

  // --- the emote in the centre -----------------------------------------------------------------
  const emoteToggle = $("[data-wheel-emote-toggle]");
  const emotePanel = $("[data-wheel-emote-panel]");
  const emoteGrid = $("[data-wheel-emote-grid]");
  const emoteSearch = $("[data-wheel-emote-search]");
  const emoteNote = $("[data-wheel-emote-note]");
  let emoteList = null;
  let emoteLoading = false;

  function setEmote(e) {
    emote = e;
    save();
    syncHub();
  }

  function renderEmotes() {
    emoteGrid.textContent = "";
    if (!emoteList) return;
    const q = emoteSearch.value.trim().toLowerCase();
    const found = (q ? emoteList.filter((e) => e.name.toLowerCase().includes(q)) : emoteList).slice(0, 240);
    emoteNote.hidden = found.length > 0;
    emoteNote.textContent = L.emoteEmpty;
    for (const e of found) {
      const b = el("button", "aspect-square rounded-md p-1 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-(--sec-accent) grid place-items-center" + (emote && emote.url === e.url ? " ring-2 ring-(--sec-accent)" : ""));
      b.type = "button";
      b.title = e.name;
      const img = el("img", "max-w-full max-h-full object-contain");
      img.loading = "lazy";
      img.src = e.url;
      img.alt = e.name;
      b.append(img);
      b.addEventListener("click", () => {
        setEmote({ name: e.name, url: e.url });
        closeEmotes();
      });
      emoteGrid.append(b);
    }
  }

  async function openEmotes() {
    emotePanel.hidden = false;
    emoteToggle.setAttribute("aria-expanded", "true");
    emoteSearch.focus();
    if (emoteList || emoteLoading) return renderEmotes();
    emoteLoading = true;
    emoteNote.hidden = false;
    emoteNote.textContent = L.emoteLoading;
    try {
      const res = await fetch(`${data.base}/wheel/emotes.json`, { headers: { accept: "application/json" } });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || res.status);
      emoteList = body.emotes;
      renderEmotes();
    } catch (_) {
      emoteNote.textContent = L.emoteFailed;
    } finally {
      emoteLoading = false;
    }
  }

  function closeEmotes() {
    emotePanel.hidden = true;
    emoteToggle.setAttribute("aria-expanded", "false");
  }

  emoteToggle.addEventListener("click", () => (emotePanel.hidden ? openEmotes() : closeEmotes()));
  emoteSearch.addEventListener("input", renderEmotes);
  $("[data-wheel-emote-none]").addEventListener("click", () => { setEmote(null); closeEmotes(); });
  document.addEventListener("click", (e) => {
    if (!emotePanel.hidden && !emotePanel.contains(e.target) && !emoteToggle.contains(e.target)) closeEmotes();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !emotePanel.hidden) closeEmotes(); });

  // --- wiring ----------------------------------------------------------------------------------
  spinBtn.dataset.label = spinBtn.textContent.trim();
  spinBtn.addEventListener("click", spin);
  hub.addEventListener("click", spin);
  resetBtn.addEventListener("click", () => (phase === "won" && mode === "plain" ? dismissWinner() : reset()));
  for (const b of root.querySelectorAll("[data-wheel-mode]")) {
    b.addEventListener("click", () => {
      if (locked() || mode === b.dataset.wheelMode) return;
      mode = b.dataset.wheelMode;
      changed(650);
    });
  }
  for (const b of root.querySelectorAll("[data-wheel-preset]")) {
    b.addEventListener("click", () => {
      if (locked()) return;
      weightMode = b.dataset.wheelPreset;
      for (const o of options) o.weight = weightOf(o);
      changed(500);
    });
  }
  // The top N by votes (ties by the list's own order: score, then title - the server sorts it so),
  // or every film with more than N votes.
  for (const b of root.querySelectorAll("[data-wheel-pick]")) {
    b.addEventListener("click", () => {
      if (locked()) return;
      if (b.dataset.wheelPick === "top") {
        const n = Math.max(1, intOf(pickTopEl, 10));
        pickTopEl.value = String(n);
        const top = new Set([...options].sort((x, y) => y.score - x.score).slice(0, n).map((o) => o.id));
        for (const o of options) o.on = top.has(o.id);
      } else {
        const n = intOf(pickAboveEl, 0);
        pickAboveEl.value = String(n);
        for (const o of options) o.on = o.score > n;
      }
      changed(500);
    });
  }
  pickTopEl.addEventListener("change", save);
  pickAboveEl.addEventListener("change", save);
  for (const b of root.querySelectorAll("[data-wheel-all]")) {
    b.addEventListener("click", () => {
      for (const o of options) o.on = b.dataset.wheelAll === "1";
      changed(500);
    });
  }
  durationEl.addEventListener("change", () => {
    durationEl.value = String(clampDuration(durationEl.value));
    save();
  });
  autoEl.addEventListener("change", save);
  hideOutEl.addEventListener("change", () => { save(); updateRows(); });

  // Hovering the wheel highlights the film under the cursor, in the wheel and in the list.
  stage.addEventListener("mousemove", (e) => {
    if (busy()) return setHover(null);
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    const d = Math.hypot(x, y);
    if (d > rect.width / 2 - 10 || d < rect.width * 0.11) return setHover(null);
    const ang = Math.atan2(y, x) + Math.PI / 2 - rotation; // from the top, clockwise, wheel frame
    const p = (((ang / TAU) % 1) + 1) % 1;
    const o = optionAt(p);
    setHover(o ? o.id : null);
  });
  stage.addEventListener("mouseleave", () => setHover(null));

  // Covers: same-origin files, drawn on the canvas once loaded.
  for (const o of options) {
    if (!o.posterUrl) continue;
    const img = new Image();
    img.decoding = "async";
    img.onload = kick;
    img.src = o.posterUrl;
    o.img = img;
  }

  window.addEventListener("resize", resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);

  buildRows();
  updateRows();
  syncControls();
  syncHub();
  retarget(reducedMotion ? 0 : 900); // the wheel opens by growing its sectors in
  resize();
})();
