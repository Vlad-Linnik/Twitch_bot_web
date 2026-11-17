// "Укладка" (/games/tile-fit) - the browser half. Levels come from window.TileFitEngine
// (public/js/games/engines/tileFitEngine.js), the same file the server checks solutions with.
//
// A piece dropped over the board stays exactly where it was dropped, even when it does not fit:
// it shakes, buzzes, and its clashing cells turn red until it is moved. Only a piece let go
// entirely outside the board goes back to the shelf. A level is solved when every board cell is
// covered and nothing on the board is red.
//
// The player never sees how many levels there are: the map shows the levels already opened and
// one unknown stop ahead, and eras appear on it only once they are reached.
//
// Every sound is synthesised with WebAudio, so the game ships no audio files; the shared volume
// slider (gameVolume.js) scales all of them.
(function () {
  "use strict";

  const Engine = window.TileFitEngine;
  const dataEl = document.getElementById("tf-data");
  if (!Engine || !dataEl) return;
  const DATA = JSON.parse(dataEl.textContent);
  const I18N = DATA.i18n;
  const NAMES = DATA.names || {};
  const LAST = Engine.LEVEL_COUNT;
  const fmt = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const $ = (id) => document.getElementById(id);

  const root = $("tf-root");
  const playSection = $("tf-play");
  const boardWrap = $("tf-board-wrap");
  const boardEl = $("tf-board");
  const trayEl = $("tf-tray");
  const statusEl = $("tf-status");
  const undoBtn = $("tf-undo");
  const resetBtn = $("tf-reset");
  const mapEl = $("tf-map");
  const mapPath = $("tf-map-path");
  const cardEl = $("tf-card");
  const splashEl = $("tf-splash");

  // A held piece is lifted out of the board/shelf into this fixed layer. It stays inside #tf-root
  // so the era's styles (and the piece's own colour variable) still apply while it is in the air.
  const dragLayer = document.createElement("div");
  dragLayer.className = "tf-drag-layer";
  root.appendChild(dragLayer);

  // ---------------------------------------------------------------------------------------------
  // Eras: ten levels each, from the stone age to cyberpunk. The material, scenery and typeface
  // are in public/css/tile-fit.css (.tf-era-N); here is only what the stylesheet cannot know:
  // each piece's colour, the accent, and what a piece sounds like when it lands. Inside an era
  // the palette is rotated every level, so neighbouring levels differ.
  // ---------------------------------------------------------------------------------------------
  const ERAS = [
    { accent: "#e0a35c", sound: "stone", palette: ["#d9b77e", "#c99c62", "#e3c592", "#b98a55", "#d3a86c", "#c4a274"] },
    { accent: "#f4c95d", sound: "stone", palette: ["#1f4fa8", "#16a2a0", "#b8452c", "#e2b350", "#2c6fd1", "#d9c49a"] },
    { accent: "#9cc3e6", sound: "stone", palette: ["#ece7dd", "#ddd6c8", "#f2ede4", "#d6d0c4", "#e6dfd2", "#e0d8cb"] },
    { accent: "#e08a3c", sound: "wood", palette: ["#8b5a32", "#7a4c29", "#9a6a3e", "#704424", "#86562f", "#93603a"] },
    { accent: "#e9bf62", sound: "stone", palette: ["#c9774e", "#d8b07a", "#7d8f6a", "#b5583f", "#e2c79b", "#8a6d9c"] },
    { accent: "#d6a552", sound: "metal", palette: ["#c9953f", "#b87333", "#d6a552", "#a8652d", "#c4883a", "#b9823f"] },
    { accent: "#d4af37", sound: "electric", palette: ["#1f7a78", "#b8432f", "#e2cf9f", "#2c4f8c", "#c98a1e", "#6b8f3a"] },
    { accent: "#a5b4fc", sound: "plastic", palette: ["#f4f4f5", "#f97316", "#38bdf8", "#facc15", "#ef4444", "#e5e7eb"] },
    { accent: "#38bdf8", sound: "digital", palette: ["#38bdf8", "#a78bfa", "#34d399", "#60a5fa", "#22d3ee", "#f472b6"] },
    { accent: "#ff2bd6", sound: "digital", palette: ["#ff2bd6", "#00f0ff", "#f9f871", "#8b5cf6", "#ff5c00", "#39ff14"] },
  ];

  const eraIndex = (level) => Math.min(ERAS.length - 1, Math.floor((level - 1) / 10));
  const eraOf = (level) => ERAS[eraIndex(level)];
  const eraName = (level) => I18N.eras[eraIndex(level)] || "";
  const levelName = (level) => NAMES[Engine.nameKey(level)] || fmt(I18N.levelLabel, { n: level });

  function applyTheme(level) {
    const era = eraOf(level);
    for (let i = 1; i <= ERAS.length; i++) root.classList.remove("tf-era-" + i);
    root.classList.add("tf-era-" + (eraIndex(level) + 1));
    root.style.setProperty("--tf-accent", era.accent);
    return era;
  }

  function pieceColor(era, level, i) {
    return era.palette[(i + ((level - 1) % 10)) % era.palette.length];
  }

  // ---------------------------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------------------------
  let audio = null;
  function ctx() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
    }
    if (audio.state === "suspended") audio.resume();
    return audio;
  }
  const vol = () => (window.gameVolume ? window.gameVolume.get() : 0.5);

  function tone({ type = "sine", from, to, dur, gain = 0.3, delay = 0, attack = 0.005 }) {
    const ac = ctx();
    if (!ac || vol() <= 0) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain * vol(), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur, gain = 0.2, freq = 800, q = 1, type = "bandpass", delay = 0, sweepTo }) {
    const ac = ctx();
    if (!ac || vol() <= 0) return;
    const t0 = ac.currentTime + delay;
    const len = Math.ceil(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain * vol(), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t0);
  }

  const sfx = {
    pick() {
      tone({ type: "triangle", from: 520, to: 780, dur: 0.07, gain: 0.18 });
      noise({ dur: 0.05, gain: 0.08, freq: 3000, q: 2 });
    },
    rotate() {
      tone({ type: "triangle", from: 1300, to: 1100, dur: 0.04, gain: 0.12 });
      noise({ dur: 0.03, gain: 0.06, freq: 5000, q: 4 });
    },
    // What a landing sounds like depends on what the piece is made of.
    place() {
      const kind = L ? eraOf(L.level).sound : "stone";
      if (kind === "stone") {
        tone({ type: "sine", from: 150, to: 55, dur: 0.18, gain: 0.55 });
        noise({ dur: 0.12, gain: 0.35, freq: 450, q: 0.7, type: "lowpass" });
        noise({ dur: 0.05, gain: 0.12, freq: 2500, q: 1.5, delay: 0.01 });
      } else if (kind === "wood") {
        tone({ type: "triangle", from: 240, to: 120, dur: 0.12, gain: 0.4 });
        noise({ dur: 0.07, gain: 0.25, freq: 900, q: 2 });
      } else if (kind === "metal") {
        tone({ type: "sine", from: 170, to: 80, dur: 0.14, gain: 0.4 });
        [523, 1187, 1873].forEach((f, i) => tone({ type: "sine", from: f, dur: 0.5 - i * 0.12, gain: 0.07 - i * 0.015 }));
        noise({ dur: 0.04, gain: 0.15, freq: 4000, q: 2 });
      } else if (kind === "plastic") {
        tone({ type: "sine", from: 420, to: 300, dur: 0.09, gain: 0.3 });
        tone({ type: "sine", from: 1200, to: 900, dur: 0.06, gain: 0.08, delay: 0.01 });
      } else if (kind === "electric") {
        tone({ type: "sine", from: 200, to: 90, dur: 0.12, gain: 0.35 });
        tone({ type: "square", from: 60, dur: 0.12, gain: 0.05 });
        noise({ dur: 0.03, gain: 0.2, freq: 6000, q: 1, delay: 0.01 });
      } else {
        tone({ type: "square", from: 880, to: 1320, dur: 0.06, gain: 0.09 });
        tone({ type: "square", from: 1760, dur: 0.05, gain: 0.06, delay: 0.06 });
        tone({ type: "sine", from: 110, to: 60, dur: 0.15, gain: 0.35 });
      }
    },
    error() {
      tone({ type: "sawtooth", from: 118, to: 96, dur: 0.28, gain: 0.16 });
      tone({ type: "square", from: 123, to: 100, dur: 0.28, gain: 0.1 });
      noise({ dur: 0.18, gain: 0.22, freq: 300, q: 0.7, type: "lowpass" });
      tone({ type: "sawtooth", from: 112, to: 90, dur: 0.18, gain: 0.12, delay: 0.14 });
    },
    // A new era: a low swell and a chord in the era's own register.
    era() {
      const kind = L ? eraOf(L.level).sound : "stone";
      const base = { stone: 98, wood: 110, metal: 131, electric: 147, plastic: 165, digital: 196 }[kind] || 110;
      noise({ dur: 1.6, gain: 0.08, freq: 300, q: 0.6, type: "lowpass", sweepTo: 2400 });
      [1, 1.5, 2, 3].forEach((m, i) =>
        tone({ type: kind === "digital" ? "square" : "sine", from: base * m, dur: 1.8 - i * 0.2, gain: kind === "digital" ? 0.04 : 0.1, delay: 0.2 + i * 0.12, attack: 0.15 }));
    },
    back() {
      noise({ dur: 0.22, gain: 0.12, freq: 2400, q: 1.2, sweepTo: 500 });
    },
    win() {
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        tone({ type: "sine", from: f, dur: 0.9, gain: 0.16, delay: i * 0.09, attack: 0.01 });
        tone({ type: "triangle", from: f * 2, dur: 0.4, gain: 0.04, delay: i * 0.09 });
      });
      noise({ dur: 1.1, gain: 0.05, freq: 7000, q: 0.5, type: "highpass", delay: 0.3 });
    },
  };

  function buzz(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_) {
      /* not allowed here - the shake is still on screen */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------------------------
  const SOLVED_KEY = "tileFit.solved";
  const BOARD_KEY = "tileFit.board";

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }
  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage blocked - progress lasts for this tab only */
    }
  }

  const solved = new Set();
  (readJson(SOLVED_KEY) || []).forEach((n) => Number.isInteger(n) && solved.add(n));
  (DATA.solved || []).forEach((n) => solved.add(n));
  const persistSolved = () => writeJson(SOLVED_KEY, [...solved].sort((a, b) => a - b));

  // Levels open one after another: the next after the furthest solved one.
  function maxOpen() {
    let m = 0;
    solved.forEach((n) => (m = Math.max(m, n)));
    return Math.min(LAST, m + 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Map of eras
  // ---------------------------------------------------------------------------------------------
  let currentLevel = null;

  function renderMap() {
    mapPath.textContent = "";
    const open = maxOpen();
    const shownUpTo = Math.min(LAST, open + (open < LAST ? 1 : 0));
    let eraBox = null;
    for (let n = 1; n <= shownUpTo; n++) {
      const unknown = n > open;
      if (!unknown && (n - 1) % 10 === 0) {
        eraBox = document.createElement("div");
        eraBox.className = "tf-map-era";
        const head = document.createElement("p");
        head.className = "tf-map-era-name";
        head.style.color = ERAS[eraIndex(n)].accent;
        head.textContent = eraName(n);
        eraBox.appendChild(head);
        mapPath.appendChild(eraBox);
      }
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "tf-stop";
      // The trail winds: each stop is pushed sideways along a slow wave.
      stop.style.setProperty("--x", Math.round(Math.sin(n * 0.9) * 70));
      stop.style.setProperty("--lc", unknown ? "#888" : ERAS[eraIndex(n)].accent);
      const node = document.createElement("span");
      node.className = "tf-stop-node";
      const num = document.createElement("span");
      const label = document.createElement("span");
      label.className = "tf-stop-label";
      const name = document.createElement("span");
      name.className = "tf-stop-name";
      const sub = document.createElement("span");
      sub.className = "tf-stop-sub";
      if (unknown) {
        stop.classList.add("tf-unknown");
        stop.disabled = true;
        num.textContent = "?";
        name.textContent = I18N.unknownLevel;
      } else {
        num.textContent = String(n);
        name.textContent = levelName(n);
        const ornament = Engine.ORNAMENTS[n];
        sub.textContent = ornament ? I18N.special : fmt(I18N.levelLabel, { n });
        if (ornament) stop.classList.add("tf-special");
        stop.classList.add(solved.has(n) ? "tf-solved" : "tf-open");
        if (n === currentLevel) stop.classList.add("tf-current");
        stop.addEventListener("click", () => {
          closeMap();
          startLevel(n);
        });
      }
      node.appendChild(num);
      label.append(name, sub);
      stop.append(node, label);
      (eraBox || mapPath).appendChild(stop);
    }
    $("tf-solved-count").textContent = fmt(I18N.solvedCount, { n: solved.size });
  }

  function openMap() {
    cancelDrag();
    renderMap();
    mapEl.hidden = false;
    // Scroll the map itself to the current stop - scrollIntoView would drag the page along too.
    const cur = mapPath.querySelector(".tf-current") || mapPath.querySelector(".tf-stop:last-of-type");
    if (cur) {
      const offset = cur.getBoundingClientRect().top - mapEl.getBoundingClientRect().top;
      mapEl.scrollTop += offset - mapEl.clientHeight / 2;
    }
  }
  function closeMap() {
    mapEl.hidden = true;
  }
  $("tf-open-map").addEventListener("click", openMap);
  $("tf-close-map").addEventListener("click", closeMap);

  // Records and help are native dialogs.
  [["tf-open-records", "tf-records"], ["tf-open-help", "tf-help"]].forEach(([btn, dlg]) => {
    const d = $(dlg);
    $(btn).addEventListener("click", () => (d.showModal ? d.showModal() : d.setAttribute("open", "")));
    d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // The card over the stage (solved)
  // ---------------------------------------------------------------------------------------------
  function showCard({ kicker, title, text, primary, onPrimary, secondary, onSecondary }) {
    $("tf-card-kicker").textContent = kicker || "";
    $("tf-card-title").textContent = title || "";
    $("tf-card-text").textContent = text || "";
    const p = $("tf-card-primary");
    const s = $("tf-card-secondary");
    p.textContent = primary || "";
    p.hidden = !primary;
    p.onclick = () => {
      hideCard();
      if (onPrimary) onPrimary();
    };
    s.textContent = secondary || "";
    s.hidden = !secondary;
    s.onclick = () => {
      hideCard();
      if (onSecondary) onSecondary();
    };
    cardEl.hidden = false;
    p.focus({ preventScroll: true });
  }
  function hideCard() {
    cardEl.hidden = true;
  }
  const cardOpen = () => !cardEl.hidden;

  // ---------------------------------------------------------------------------------------------
  // Play state
  // ---------------------------------------------------------------------------------------------
  let L = null; // the level from the engine
  let pieces = []; // {i, cells, rot, placed: {r,c}|null, color, el, slot}
  let history = [];
  let cs = 48; // board cell size, px
  let ts = 26; // shelf cell size, px
  let solvedNow = false;
  let marksEl = null;

  const shapeOf = (p) => Engine.rotate(p.cells, p.rot);
  const dims = (cells) => {
    let h = 0;
    let w = 0;
    cells.forEach(([r, c]) => {
      h = Math.max(h, r + 1);
      w = Math.max(w, c + 1);
    });
    return { w, h };
  };

  const snapshot = () => pieces.map((p) => ({ rot: p.rot, placed: p.placed ? { ...p.placed } : null }));

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 200) history.shift();
    undoBtn.disabled = false;
  }

  function restore(state) {
    state.forEach((s, i) => {
      pieces[i].rot = ((s.rot % 4) + 4) % 4;
      pieces[i].placed = s.placed ? { r: s.placed.r, c: s.placed.c } : null;
    });
  }

  function saveBoard() {
    writeJson(BOARD_KEY, { level: L.level, version: L.version, pieces: snapshot() });
  }

  function setTitle(n) {
    $("tf-level-title").textContent = fmt(I18N.levelLabel, { n });
    $("tf-era-title").textContent = eraName(n);
    $("tf-level-name").textContent = levelName(n);
    const chip = $("tf-special-chip");
    chip.hidden = !L.ornament;
    chip.textContent = I18N.special;
  }

  function startLevel(n) {
    cancelDrag();
    hideCard();
    L = Engine.generateLevel(n);
    const enteringEra = currentLevel !== null && eraIndex(currentLevel) !== eraIndex(n);
    currentLevel = n;
    solvedNow = false;
    history = [];
    undoBtn.disabled = true;
    const era = applyTheme(n);
    pieces = L.pieces.map((pc, i) => ({
      i,
      cells: pc.cells,
      rot: pc.startRotation,
      placed: null,
      color: pieceColor(era, n, i),
      el: null,
      slot: null,
    }));
    const saved = readJson(BOARD_KEY);
    const resumed = saved && saved.level === n && saved.version === L.version && Array.isArray(saved.pieces) &&
      saved.pieces.length === pieces.length;
    if (resumed) restore(saved.pieces);
    setTitle(n);
    buildBoard();
    renderAll();
    saveBoard();

    // A new era is announced the first time it is reached (and on the very first visit to it).
    if ((enteringEra || n === 1) && (n - 1) % 10 === 0 && !solved.has(n)) showSplash(n);
  }

  function showSplash(n) {
    $("tf-splash-name").textContent = eraName(n);
    splashEl.hidden = false;
    splashEl.style.animation = "none";
    void splashEl.offsetWidth;
    splashEl.style.animation = "";
    sfx.era();
    setTimeout(() => (splashEl.hidden = true), 2600);
  }

  function computeSizes() {
    const avail = Math.max(200, boardWrap.clientWidth - 32);
    const byWidth = Math.floor(avail / L.cols);
    const byHeight = Math.floor((window.innerHeight * 0.48) / L.rows);
    cs = Math.max(24, Math.min(58, byWidth, byHeight));
    ts = Math.max(14, Math.round(cs * 0.6));
    root.style.setProperty("--tf-cs", cs + "px");
  }

  function buildBoard() {
    computeSizes();
    boardEl.textContent = "";
    // The era's closing ornament: the board itself shimmers in the era's accent.
    boardEl.classList.toggle("tf-ornate", !!L.ornament);
    boardEl.style.width = L.cols * cs + "px";
    boardEl.style.height = L.rows * cs + "px";
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        if (!L.mask[r][c]) continue;
        const cell = document.createElement("div");
        cell.className = "tf-cell" + ((r + c) % 2 ? " tf-alt" : "");
        cell.style.left = c * cs + "px";
        cell.style.top = r * cs + "px";
        cell.style.backgroundPosition = `${-c * cs}px ${-r * cs}px`;
        cell.style.setProperty("--d", ((r + c) * 0.12).toFixed(2) + "s");
        cell.dataset.r = r;
        cell.dataset.c = c;
        boardEl.appendChild(cell);
      }
    }
    drawMarks();
    trayEl.textContent = "";
    pieces.forEach((p) => {
      const slot = document.createElement("div");
      slot.className = "tf-slot";
      // Sized for the piece's longest side, so turning it on the shelf never reflows the shelf.
      const d = dims(p.cells);
      const side = Math.max(d.w, d.h) * ts;
      slot.style.width = side + "px";
      slot.style.height = side + "px";
      p.slot = slot;
      trayEl.appendChild(slot);
      const el = document.createElement("div");
      el.className = "tf-piece";
      el.style.setProperty("--tf-pc", p.color);
      el.dataset.piece = p.i;
      p.el = el;
    });
  }

  // The figure's features (eyes, snout, door...) as one SVG in cell units over the board.
  function drawMarks() {
    marksEl = null;
    if (!L.marks || !L.marks.length) return;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "tf-marks");
    svg.setAttribute("viewBox", `0 0 ${L.cols} ${L.rows}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "0.14", "stroke-linecap": "round" };
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
      svg.appendChild(e);
    };
    L.marks.forEach((m) => {
      // A dot may carry its own colour (the clown's red nose); the rest follow the theme's ink.
      if (m[0] === "dot") el("circle", { cx: m[2], cy: m[1], r: m[3], fill: typeof m[4] === "string" ? m[4] : "currentColor" });
      else if (m[0] === "ring") el("ellipse", { cx: m[2], cy: m[1], rx: m[3], ry: m[4], ...stroke });
      else if (m[0] === "line") el("line", { x1: m[2], y1: m[1], x2: m[4], y2: m[3], ...stroke });
      else if (m[0] === "rect") el("rect", { x: m[2], y: m[1], width: m[4], height: m[3], rx: 0.15, ...stroke });
    });
    boardEl.appendChild(svg);
    marksEl = svg;
  }

  function drawPiece(p, size) {
    const cells = shapeOf(p);
    const set = new Set(cells.map(([r, c]) => r + ":" + c));
    const d = dims(cells);
    p.el.textContent = "";
    p.el.style.width = d.w * size + "px";
    p.el.style.height = d.h * size + "px";
    cells.forEach(([r, c]) => {
      const pc = document.createElement("div");
      pc.className = "tf-pcell";
      const up = set.has(r - 1 + ":" + c);
      const down = set.has(r + 1 + ":" + c);
      const left = set.has(r + ":" + (c - 1));
      const right = set.has(r + ":" + (c + 1));
      if (!up) pc.classList.add("e-t");
      if (!down) pc.classList.add("e-b");
      if (!left) pc.classList.add("e-l");
      if (!right) pc.classList.add("e-r");
      if (!up && !left) pc.classList.add("r-tl");
      if (!up && !right) pc.classList.add("r-tr");
      if (!down && !left) pc.classList.add("r-bl");
      if (!down && !right) pc.classList.add("r-br");
      // One texture across the whole piece instead of the same patch repeated in every cell.
      pc.style.backgroundPosition = `${-c * size}px ${-r * size}px`;
      pc.style.left = c * size + "px";
      pc.style.top = r * size + "px";
      pc.style.width = size + "px";
      pc.style.height = size + "px";
      pc.dataset.r = r;
      pc.dataset.c = c;
      p.el.appendChild(pc);
    });
  }

  function seat(p) {
    if (p.placed) {
      drawPiece(p, cs);
      p.el.style.left = p.placed.c * cs + "px";
      p.el.style.top = p.placed.r * cs + "px";
      if (p.el.parentNode !== boardEl) boardEl.appendChild(p.el);
      p.slot.classList.add("tf-empty");
    } else {
      drawPiece(p, ts);
      p.el.style.left = "";
      p.el.style.top = "";
      if (p.el.parentNode !== p.slot) p.slot.appendChild(p.el);
      p.slot.classList.remove("tf-empty");
    }
  }

  function renderAll() {
    pieces.forEach(seat);
    validate();
    updateStatus();
  }

  // Marks every clashing cell red. A cell clashes when it is off the board's shape or shares a
  // board cell with another piece. Also counts how much of the board is covered cleanly.
  function validate() {
    const count = new Map();
    pieces.forEach((p) => {
      if (!p.placed) return;
      shapeOf(p).forEach(([dr, dc]) => {
        const k = p.placed.r + dr + ":" + (p.placed.c + dc);
        count.set(k, (count.get(k) || 0) + 1);
      });
    });
    let allValid = true;
    pieces.forEach((p) => {
      if (!p.placed) {
        p.el.classList.remove("tf-invalid");
        p.el.querySelectorAll(".tf-bad").forEach((e) => e.classList.remove("tf-bad"));
        return;
      }
      let bad = false;
      p.el.querySelectorAll(".tf-pcell").forEach((pc) => {
        const r = p.placed.r + Number(pc.dataset.r);
        const c = p.placed.c + Number(pc.dataset.c);
        const off = r < 0 || r >= L.rows || c < 0 || c >= L.cols || !L.mask[r][c];
        const clash = off || count.get(r + ":" + c) > 1;
        pc.classList.toggle("tf-bad", clash);
        if (clash) bad = true;
      });
      p.el.classList.toggle("tf-invalid", bad);
      if (bad) allValid = false;
    });
    let covered = 0;
    count.forEach((n, k) => {
      const [r, c] = k.split(":").map(Number);
      if (r >= 0 && r < L.rows && c >= 0 && c < L.cols && L.mask[r][c]) covered++;
    });
    return { complete: allValid && covered === L.area };
  }

  const isPieceValid = (p) => p.placed && !p.el.classList.contains("tf-invalid");

  function updateStatus() {
    statusEl.textContent = solvedNow ? "" : fmt(I18N.piecesLeft, { n: pieces.filter((p) => !p.placed).length });
  }

  function feedback(p) {
    p.el.classList.remove("tf-shake", "tf-pop");
    void p.el.offsetWidth; // restart the animation
    if (isPieceValid(p)) {
      p.el.classList.add("tf-pop");
      sfx.place();
      buzz(12);
    } else {
      p.el.classList.add("tf-shake");
      sfx.error();
      buzz([70, 40, 90]);
    }
  }

  function afterChange(p) {
    const v = validate();
    updateStatus();
    saveBoard();
    if (p) feedback(p);
    if (v.complete) win();
  }

  // ---------------------------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------------------------
  function rotatePiece(p) {
    if (solvedNow) return;
    pushHistory();
    const before = dims(shapeOf(p));
    p.rot = (p.rot + 1) % 4;
    if (p.placed) {
      // Turn around the piece's middle rather than its corner, so it stays where the eye is.
      p.placed.r += Math.round((before.h - before.w) / 2);
      p.placed.c += Math.round((before.w - before.h) / 2);
      seat(p);
      afterChange(p);
    } else {
      seat(p);
      sfx.rotate();
      saveBoard();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Dragging
  // ---------------------------------------------------------------------------------------------
  let press = null; // {p, x, y, id}
  let drag = null; // {p, fx, fy, x, y, before}

  function pieceFromEvent(e) {
    const el = e.target.closest && e.target.closest(".tf-piece");
    if (!el || !playSection.contains(el)) return null;
    return pieces[Number(el.dataset.piece)] || null;
  }

  playSection.addEventListener("contextmenu", (e) => e.preventDefault());

  playSection.addEventListener("pointerdown", (e) => {
    if (solvedNow || drag || cardOpen()) return;
    const p = pieceFromEvent(e);
    if (!p) return;
    ctx();
    e.preventDefault();
    if (e.button === 2) {
      rotatePiece(p);
      return;
    }
    if (e.button !== 0) return;
    press = { p, x: e.clientX, y: e.clientY, id: e.pointerId };
  });

  window.addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.id) {
      moveDrag(e.clientX, e.clientY);
      return;
    }
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    beginDrag(press, e.clientX, e.clientY);
    press = null;
  });

  window.addEventListener("pointerup", (e) => {
    if (drag && e.pointerId === drag.id) {
      endDrag(e.clientX, e.clientY);
      return;
    }
    if (press && e.pointerId === press.id) {
      const p = press.p;
      press = null;
      rotatePiece(p);
    }
  });

  window.addEventListener("pointercancel", () => {
    press = null;
    cancelDrag();
  });

  function beginDrag(pr, x, y) {
    const p = pr.p;
    const rect = p.el.getBoundingClientRect();
    const cur = p.placed ? cs : ts;
    drag = {
      p,
      id: pr.id,
      // Where on the piece it was grabbed, in cells - kept under the pointer as it grows from
      // shelf size to board size.
      fx: (pr.x - rect.left) / cur,
      fy: (pr.y - rect.top) / cur,
      x,
      y,
      before: snapshot(),
    };
    drawPiece(p, cs);
    p.el.classList.remove("tf-shake", "tf-pop", "tf-invalid");
    p.el.querySelectorAll(".tf-bad").forEach((c) => c.classList.remove("tf-bad"));
    dragLayer.appendChild(p.el);
    if (p.placed) {
      p.placed = null;
      validate();
    }
    p.slot.classList.add("tf-empty");
    sfx.pick();
    moveDrag(x, y);
  }

  function moveDrag(x, y) {
    drag.x = x;
    drag.y = y;
    drag.p.el.style.left = x - drag.fx * cs + "px";
    drag.p.el.style.top = y - drag.fy * cs + "px";
    drawGhost();
  }

  function snapTarget() {
    const br = boardEl.getBoundingClientRect();
    const left = drag.x - drag.fx * cs;
    const top = drag.y - drag.fy * cs;
    const r = Math.round((top - br.top) / cs);
    const c = Math.round((left - br.left) / cs);
    const cells = shapeOf(drag.p);
    const onBoard = cells.some(([dr, dc]) => {
      const rr = r + dr;
      const cc = c + dc;
      return rr >= 0 && rr < L.rows && cc >= 0 && cc < L.cols;
    });
    return { r, c, cells, onBoard };
  }

  function clearGhost() {
    boardEl.querySelectorAll(".tf-ghost-ok, .tf-ghost-bad").forEach((el) => el.classList.remove("tf-ghost-ok", "tf-ghost-bad"));
  }

  function drawGhost() {
    clearGhost();
    const t = snapTarget();
    if (!t.onBoard) return;
    const taken = new Set();
    pieces.forEach((p) => {
      if (p.placed && p !== drag.p) shapeOf(p).forEach(([dr, dc]) => taken.add(p.placed.r + dr + ":" + (p.placed.c + dc)));
    });
    let fits = true;
    const targets = [];
    t.cells.forEach(([dr, dc]) => {
      const r = t.r + dr;
      const c = t.c + dc;
      if (r < 0 || r >= L.rows || c < 0 || c >= L.cols || !L.mask[r][c] || taken.has(r + ":" + c)) fits = false;
      const cell = boardEl.querySelector(`.tf-cell[data-r="${r}"][data-c="${c}"]`);
      if (cell) targets.push(cell);
    });
    targets.forEach((cell) => cell.classList.add(fits ? "tf-ghost-ok" : "tf-ghost-bad"));
  }

  function rotateDragged() {
    const d = dims(shapeOf(drag.p));
    // (fx, fy) inside a w x h box turns clockwise into (h - fy, fx).
    const fx = d.h - drag.fy;
    const fy = drag.fx;
    drag.p.rot = (drag.p.rot + 1) % 4;
    drag.fx = fx;
    drag.fy = fy;
    drawPiece(drag.p, cs);
    sfx.rotate();
    moveDrag(drag.x, drag.y);
  }

  function endDrag(x, y) {
    moveDrag(x, y);
    const p = drag.p;
    const t = snapTarget();
    history.push(drag.before);
    if (history.length > 200) history.shift();
    undoBtn.disabled = false;
    drag = null;
    clearGhost();
    if (t.onBoard) {
      p.placed = { r: t.r, c: t.c };
      seat(p);
      afterChange(p);
    } else {
      p.placed = null;
      seat(p);
      sfx.back();
      afterChange(null);
    }
  }

  function cancelDrag() {
    if (!drag) return;
    const p = drag.p;
    restore(drag.before);
    drag = null;
    clearGhost();
    seat(p);
    validate();
  }

  window.addEventListener("keydown", (e) => {
    if (!mapEl.hidden) {
      if (e.key === "Escape") closeMap();
      return;
    }
    if (drag && (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К" || e.key === " ")) {
      e.preventDefault();
      rotateDragged();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "я")) {
      e.preventDefault();
      undo();
    } else if (e.key === "Escape" && drag) {
      cancelDrag();
    }
  });

  window.addEventListener("wheel", (e) => {
    if (!drag) return;
    e.preventDefault();
    rotateDragged();
  }, { passive: false });

  // While a piece is held, the right button turns it instead of opening a menu.
  window.addEventListener("mousedown", (e) => {
    if (drag && e.button === 2) {
      e.preventDefault();
      rotateDragged();
    }
  });
  window.addEventListener("contextmenu", (e) => {
    if (drag) e.preventDefault();
  });

  // ---------------------------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------------------------
  function undo() {
    if (solvedNow || drag || cardOpen() || !history.length) return;
    restore(history.pop());
    undoBtn.disabled = history.length === 0;
    renderAll();
    saveBoard();
    sfx.back();
  }

  function resetBoard() {
    if (solvedNow || drag) return;
    pushHistory();
    pieces.forEach((p) => (p.placed = null));
    renderAll();
    saveBoard();
    sfx.back();
  }

  undoBtn.addEventListener("click", undo);
  resetBtn.addEventListener("click", () => {
    if (cardOpen()) return;
    resetBoard();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!L || drag) return;
      buildBoard();
      renderAll();
      if (solvedNow && marksEl) marksEl.classList.add("tf-marks-on");
    }, 120);
  });

  // ---------------------------------------------------------------------------------------------
  // Winning
  // ---------------------------------------------------------------------------------------------
  function win() {
    solvedNow = true;
    updateStatus();
    sfx.win();
    buzz([30, 50, 30, 50, 120]);
    boardEl.querySelectorAll(".tf-cell").forEach((cell) => {
      cell.style.animationDelay = (Number(cell.dataset.r) + Number(cell.dataset.c)) * 45 + "ms";
      cell.classList.add("tf-win-wave");
    });
    pieces.forEach((p) => {
      if (!p.placed) return;
      p.el.querySelectorAll(".tf-pcell").forEach((pc) => {
        pc.style.animation = "tf-wave 0.9s ease-out both";
        pc.style.animationDelay = (p.placed.r + Number(pc.dataset.r) + p.placed.c + Number(pc.dataset.c)) * 45 + "ms";
      });
    });
    if (marksEl) marksEl.classList.add("tf-marks-on");
    sparks();

    const first = !solved.has(L.level);
    solved.add(L.level);
    persistSolved();
    writeJson(BOARD_KEY, null);

    const last = L.level >= LAST;
    const isFigure = L.marks && Engine.FIGURE_NAMES.includes(L.name);
    const level = L.level;
    setTimeout(() => {
      if (!solvedNow || L.level !== level) return;
      showCard({
        kicker: fmt(I18N.levelLabel, { n: level }),
        title: isFigure ? fmt(I18N.figureDone, { name: levelName(level) }) : I18N.solvedTitle,
        text: last ? I18N.allSolved : "",
        primary: last ? "" : I18N.next,
        onPrimary: () => startLevel(level + 1),
        secondary: I18N.toLevels,
        onSecondary: openMap,
      });
      if (DATA.loggedIn) submit(L, first);
    }, isFigure ? 1500 : 950);
  }

  function sparks() {
    const stage = root.querySelector(".tf-stage");
    const pr = stage.getBoundingClientRect();
    const br = boardEl.getBoundingClientRect();
    const cx = br.left - pr.left + br.width / 2;
    const cy = br.top - pr.top + br.height / 2;
    const era = eraOf(L.level);
    for (let i = 0; i < 34; i++) {
      const s = document.createElement("span");
      s.className = "tf-spark";
      const a = (i / 34) * Math.PI * 2 + Math.random() * 0.3;
      const dist = 90 + Math.random() * 160;
      s.style.left = cx + "px";
      s.style.top = cy + "px";
      s.style.setProperty("--dx", Math.cos(a) * dist + "px");
      s.style.setProperty("--dy", Math.sin(a) * dist + "px");
      s.style.setProperty("--sc", era.palette[i % era.palette.length]);
      s.style.animationDelay = Math.random() * 0.25 + "s";
      stage.appendChild(s);
      setTimeout(() => s.remove(), 1400);
    }
  }

  async function submit(level, first) {
    const placements = pieces.map((p) => ({ rot: p.rot, r: p.placed.r, c: p.placed.c }));
    const body = new URLSearchParams({
      level: String(level.level),
      version: String(level.version),
      placements: JSON.stringify(placements),
      _csrf: DATA.csrf || "",
    });
    const textEl = $("tf-card-text");
    try {
      const res = await fetch("/games/tile-fit/solve.json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        credentials: "same-origin",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !json.ok) throw new Error((json && json.error) || String(res.status));
      if (json.leaderboard) renderLeaderboard(json.leaderboard);
      if (first && !textEl.textContent) textEl.textContent = I18N.saved;
    } catch (_) {
      if (!textEl.textContent) textEl.textContent = I18N.saveFailed;
    }
  }

  function lbRow(row, me) {
    const li = document.createElement("li");
    li.className = "tf-lb-row" + (row.isMe || me ? " tf-lb-me" : "") + (me ? " tf-lb-sep" : "");
    const rank = document.createElement("span");
    rank.className = "tf-lb-rank";
    rank.textContent = String(row.rank);
    const name = document.createElement("span");
    name.className = "tf-lb-name";
    name.textContent = row.displayName;
    if (row.color) name.style.color = row.color;
    const score = document.createElement("span");
    score.className = "tf-lb-score";
    score.textContent = String(row.score);
    li.append(rank, name, score);
    return li;
  }

  function renderLeaderboard(lb) {
    const list = $("tf-lb-list");
    list.textContent = "";
    if (!lb.rows.length) {
      const li = document.createElement("li");
      li.className = "tf-lb-empty";
      li.textContent = I18N.leaderboardEmpty;
      list.appendChild(li);
    }
    lb.rows.forEach((row) => list.appendChild(lbRow(row, false)));
    if (lb.myRow) list.appendChild(lbRow(lb.myRow, true));
  }

  // ---------------------------------------------------------------------------------------------
  // Boot: straight into play - the level that was open, otherwise the furthest one reached.
  // ---------------------------------------------------------------------------------------------
  const savedBoard = readJson(BOARD_KEY);
  if (savedBoard && savedBoard.version === Engine.LEVELS_VERSION && savedBoard.level >= 1 &&
      savedBoard.level <= maxOpen()) {
    startLevel(savedBoard.level);
  } else {
    startLevel(maxOpen());
  }
})();
