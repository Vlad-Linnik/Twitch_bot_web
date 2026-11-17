// "Укладка" (/games/tile-fit) - the browser half. Levels come from window.TileFitEngine
// (public/js/games/engines/tileFitEngine.js), the same file the server checks solutions with.
//
// A piece dropped over the board snaps into the grid only when it fits there. One that does not
// fit is left "loose" exactly where it was let go - no snapping - on top of the others: it shakes,
// buzzes, and the cells that would clash turn red until it is moved. Only a piece let go entirely
// outside the board goes back to the shelf. Since only a fitting piece ever enters the grid,
// pieces in the grid never overlap, and a level is solved when the grid is full.
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
    { accent: "#84cc16", sound: "wood", palette: ["#65a30d", "#16a34a", "#ca8a04", "#0d9488", "#4d7c0f", "#a3e635"] },
    { accent: "#fb923c", sound: "plastic", palette: ["#f5f5f4", "#ea580c", "#a8a29e", "#fbbf24", "#e7e5e4", "#c2410c"] },
    { accent: "#c084fc", sound: "digital", palette: ["#a78bfa", "#22d3ee", "#f0abfc", "#818cf8", "#5eead4", "#e879f9"] },
    { accent: "#d6b77e", sound: "stone", palette: ["#d9b77e", "#c99c62", "#e3c592", "#b98a55", "#d3a86c", "#c4a274"] },
    // Folk crafts: a side branch, not a step on the line (see FOLK_ERA).
    { accent: "#ef4444", sound: "wood", palette: ["#dc2626", "#facc15", "#16a34a", "#1d4ed8", "#f8fafc", "#0c0a09"] },
  ];
  const MAIN_ERAS = 14;

  // A secret level is dressed in the era it was found in.
  const SECRET_ERA = { 1001: 1, 1002: 7, 1003: 6, 4500: 4 };
  const isSecret = (level) => SECRET_ERA[level] !== undefined;
  // The folk-craft branch (201-210) opens once level 30 is solved and is walked in order.
  const FOLK_FIRST = 201;
  const FOLK_LAST = 210;
  const FOLK_GATE = 30;
  const FOLK_ERA = 14;
  const isFolk = (level) => level >= FOLK_FIRST && level <= FOLK_LAST;
  // The level of the day wears one of the first ten eras, a different one each day; a channel's
  // emote boards are shown in glossy enamel, which keeps the emote's own colours readable.
  const isDaily = (level) => Engine.isDaily(level);
  const isCustom = (level) => level >= 5000 && level <= 5999;
  const CUSTOM_ERA = 6;
  const eraIndex = (level) =>
    isSecret(level) ? SECRET_ERA[level]
      : isFolk(level) ? FOLK_ERA
        : isDaily(level) ? level % 10
          : isCustom(level) ? CUSTOM_ERA
            : Math.min(MAIN_ERAS - 1, Math.floor((level - 1) / 10));
  const customBoards = new Map(); // id -> {emote, channel, image}
  function todayNumber() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  const eraOf = (level) => ERAS[eraIndex(level)];
  const eraName = (level) => I18N.eras[eraIndex(level)] || "";
  const levelName = (level) => {
    if (isDaily(level)) {
      const key = Engine.generateLevel(level).figureKey;
      return key && NAMES[key] ? NAMES[key] : fmt(I18N.dailyName, { date: String(level % 100).padStart(2, "0") + "." + String(Math.floor(level / 100) % 100).padStart(2, "0") });
    }
    if (isCustom(level)) return (customBoards.get(level) || {}).emote || "?";
    return NAMES[Engine.nameKey(level)] || fmt(I18N.levelLabel, { n: level });
  };

  // ---------------------------------------------------------------------------------------------
  // Textures. The stylesheet draws every material from inline SVG noise (feTurbulence). WebKit
  // does not keep a rendered SVG background: every repaint of an element that uses one runs the
  // SVG filter again, at device resolution, for every layer - and a piece cell stacks up to four.
  // Measured in Playwright's WebKit at an iPhone's 390x844 @3x, one drag step over a Middle Ages
  // board (level 35) took 2068 ms with the textures and 423 ms with background-image switched off;
  // Chrome caches the raster, which is why desktops never showed it. So each texture is drawn
  // once into a canvas at the device's pixel ratio and swapped in as a plain bitmap: same picture,
  // and a repaint becomes an image copy. Until that is done (and wherever a browser refuses -
  // a tainted canvas, no toBlob) the SVG stays in place, which is only slower, never wrong.
  // ---------------------------------------------------------------------------------------------
  const TEXTURE_VARS = ["--tx-grain", "--tx-clouds", "--tx-veins", "--tx-wood", "--tx-brushed", "--tx-circuit"];

  function rasterizeTextures() {
    if (!window.Promise || !HTMLCanvasElement.prototype.toBlob || !window.URL || !URL.createObjectURL) return;
    const computed = getComputedStyle(root);
    const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const jobs = TEXTURE_VARS.map((name) => {
      const value = computed.getPropertyValue(name).trim();
      const m = /^url\(\s*(["'])(data:image\/svg\+xml[^]*)\1\s*\)$/.exec(value);
      const size = m && /<svg[^>]*\swidth='(\d+)'\s+height='(\d+)'/.exec(m[2]);
      if (!size) return Promise.resolve(null);
      const w = Number(size[1]);
      const h = Number(size[2]);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => resolve(blob ? [name, URL.createObjectURL(blob)] : null), "image/png");
          } catch (_) {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = m[2];
      });
    });
    // Swapped in together: each property change repaints every textured element once.
    Promise.all(jobs).then((done) => {
      done.forEach((pair) => pair && root.style.setProperty(pair[0], `url("${pair[1]}")`));
    });
  }

  function applyTheme(level) {
    const era = eraOf(level);
    for (let i = 1; i <= ERAS.length; i++) root.classList.remove("tf-era-" + i);
    root.classList.add("tf-era-" + (eraIndex(level) + 1));
    root.style.setProperty("--tf-accent", era.accent);
    return era;
  }

  // ---------------------------------------------------------------------------------------------
  // Quotes: a solved level gets a line, the way a discovered technology does in a strategy game -
  // a picture its own (Orwell for the piggy, Gagarin for the rocket), otherwise the era's own
  // words, handed out in order so an era never repeats itself. A level that took many misplaced
  // drops gets a consolation line about mistakes instead. Every quote is real and attributed to
  // its source; a disputed one says "attributed to". The texts live in the locale files under
  // games.tileFit.quotes.
  // ---------------------------------------------------------------------------------------------
  const QUOTE_FIGURES = {
    piggy: "orwell", clown: "worldStage", fox: "tamed", owl: "minerva", elephant: "krylovElephant",
    crown: "monomakh", castle: "coke", ghost: "horatio", teapot: "teaTime", key: "bacon",
    rocket: "gagarin", astronaut: "armstrong", lion: "tipu", cat: "kiplingCat", fish: "fishProverb",
    turtle: "tortoise", house: "homeProverb", mouse: "horaceMouse", chick: "chickens", ufo: "fermi",
    dino: "lifeFinds", snowman: "tyutchev", robot: "asimovLaw", butterfly: "zhuangzi", whale: "ishmael",
    star: "kant", hedgehog: "archilochus", doggy: "stael", plane: "kelvin", boat: "pompey",
    tree: "fuller", cupcake: "cake", frog: "basho", apple: "appleProverb",
    sunRa: "aten", moonRabbit: "goddard", bigTop: "chaplin", simplexAmulet: "voltaireBetter",
    bee: "beesEinstein", rover: "curiosity", schrodinger: "schrodingerCat", ozymandias: "shelley",
    dymkovo: "slowFar", samovar: "samovarSaying", khokhloma: "notGold", gzhel: "izbaPies", palekh: "beautySaves",
    gorodets: "reapSow", lace: "measureSeven", zhostovo: "masterWork", matryoshka: "smallPrecious", shawl: "frostSun",
    vase: "keats", locomotive: "thoreau", lightbulb: "edisonCandles", earth: "paleBlueDot", alien: "clarkeAlone",
  };
  const QUOTE_ERAS = [
    ["laozi", "franklinTool", "fireProverb", "prutkovRoot", "prutkovEmbrace", "laborProverb", "confucius", "chekhov"],
    ["herodotus", "pyramids", "ptahhotep", "napoleon", "champollion", "delphi", "sunTzu", "prutkovHappy"],
    ["archimedesLever", "eureka", "hippocrates", "heraclitus", "protagoras", "socrates", "caesar"],
    ["bernard", "benedictine", "dante", "occam"],
    ["galileo", "leonardo", "hamlet", "michelangelo", "descartes"],
    ["boulton", "newton", "lovelace", "franklinTime", "verne"],
    ["edisonGenius", "faraday", "bell", "bender"],
    ["tsiolkovsky", "perAspera", "saganCosmos", "kepler", "tereshkova", "adams", "haldane", "pascal"],
    ["kay", "torvalds", "wheeler", "clarke", "picasso", "knuth", "hopper", "dijkstra"],
    ["gibson", "dick", "turing", "asimovViolence", "wiener", "hawking", "mcluhan", "brand"],
    ["sapling", "borrowed", "wildness", "lookDeep", "carson", "gandhiNeed", "baconNature", "leopold"],
    ["muskMars", "saganSomewhere", "wells", "vonBraun", "hawkingStars", "clarke2", "kennedy", "heinlein"],
    ["einsteinDice", "bohrReply", "feynman", "bohrPredict", "heisenberg", "planck", "itFromBit", "imagination"],
    ["heraclitusRiver", "sicTransit", "eliotBeginning", "santayana", "marcus", "nietzsche", "eliotEnd", "solomonRing"],
  ];
  // The very last level closes the circle with its own line.
  const QUOTE_LEVELS = { 140: "ecclesiastes" };
  const QUOTE_MISTAKES = ["edisonFail", "wilde", "seneca", "apollo13", "beckett"];
  const MANY_MISTAKES = 5;
  const QUOTES = DATA.quotes || {};

  function quoteIdFor(level, mistakes) {
    if (mistakes >= MANY_MISTAKES) return QUOTE_MISTAKES[level % QUOTE_MISTAKES.length];
    if (isDaily(level) || isCustom(level)) {
      const key = Engine.generateLevel(level).figureKey;
      if (key && QUOTE_FIGURES[key]) return QUOTE_FIGURES[key];
      const pool = QUOTE_ERAS[eraIndex(level)] || QUOTE_ERAS[8];
      return pool[level % pool.length];
    }
    if (QUOTE_LEVELS[level]) return QUOTE_LEVELS[level];
    const own = QUOTE_FIGURES[Engine.nameKey(level)];
    if (own) return own;
    const era = eraIndex(level);
    const pool = QUOTE_ERAS[era] || QUOTE_ERAS[QUOTE_ERAS.length - 1];
    let k = 0;
    for (let lv = era * 10 + 1; lv < level; lv++) if (!QUOTE_FIGURES[Engine.nameKey(lv)] && !QUOTE_LEVELS[lv]) k++;
    return pool[k % pool.length];
  }

  // Read the quote out loud with the browser's own voice, in the page's language.
  const quoteBtn = $("tf-quote-read");
  let speaking = false;
  function stopReading() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    speaking = false;
    quoteBtn.textContent = I18N.readAloud;
  }
  function readQuote(q) {
    if (!window.speechSynthesis || !q) return;
    stopReading();
    const u = new SpeechSynthesisUtterance(q.text + " … " + q.author);
    u.lang = DATA.lang === "ru" ? "ru-RU" : "en-US";
    u.rate = 0.9;
    u.pitch = 0.95;
    u.volume = Math.min(1, vol() * 1.6);
    u.onend = stopReading;
    speaking = true;
    quoteBtn.textContent = I18N.stopReading;
    window.speechSynthesis.speak(u);
  }
  let currentQuote = null;
  quoteBtn.addEventListener("click", () => (speaking ? stopReading() : readQuote(currentQuote)));
  if (!window.speechSynthesis) quoteBtn.hidden = true;

  // ---------------------------------------------------------------------------------------------
  // Living figures: an assembled picture moves for a moment - the rocket lifts off, the fish
  // swims, the butterfly flaps, animals bounce and blink. Eyes are the figure's plain dots of
  // eye size; a coloured dot (the clown's nose) never blinks.
  // ---------------------------------------------------------------------------------------------
  const MOTION = {
    fly: ["rocket", "ufo", "astronaut", "plane"],
    swim: ["fish", "whale", "boat", "octopus", "crab", "turtle"],
    flap: ["butterfly", "owl", "chick", "bee"],
    float: ["ghost", "umbrella"],
    twinkle: ["star", "crown", "key", "sunRa", "earth", "simplexAmulet"],
    flicker: ["pumpkin", "lightbulb"],
    drive: ["locomotive", "rover"],
    wobble: ["vase", "ozymandias", "schrodinger", "bigTop", "snowman", "teapot", "mug", "cupcake", "iceCream", "watermelon", "mushroom", "apple", "tree", "cactus", "house", "castle", "anchor"],
  };
  const BLINKERS = new Set(["piggy", "cat", "fox", "lion", "bunny", "bear", "mouse", "frog", "penguin", "doggy", "owl", "chick",
    "crab", "octopus", "ghost", "clown", "robot", "dino", "elephant", "whale", "fish", "hedgehog", "moonRabbit"]);
  function motionOf(name) {
    for (const [m, list] of Object.entries(MOTION)) if (list.includes(name)) return m;
    return "bounce";
  }

  // ---------------------------------------------------------------------------------------------
  // Mastery, kept in this browser only - it is a personal record, not a score anyone competes on:
  //   1 star  - solved
  //   2 stars - not one piece dropped where it did not fit
  //   3 stars - that, and no undo or reset, and every piece put down exactly once
  // A level solved again with a different layout counts as another solution found.
  // ---------------------------------------------------------------------------------------------
  const STARS_KEY = "tileFit.stars";
  const SOLUTIONS_KEY = "tileFit.solutions";
  const MAX_SOLUTIONS_KEPT = 6;

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
    // Browsers refuse (and log) a vibration before the first real tap on the page.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_) {
      /* not allowed here - the shake is still on screen */
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Music: one piece per era. Seven are CC0 recordings (public/sounds/tile-fit/, CREDITS.md
  // there); for Antiquity, the Age of Steam and Cyberpunk nothing suitable and light enough was
  // found, so those are composed live here with the same WebAudio as the sound effects - a lyre
  // over a drone, a clockwork music-box waltz, a synthwave groove. Browsers allow sound only after
  // a gesture, so nothing plays until the first press on the stage. The shared volume slider
  // scales it, the note button in the corner switches it off (remembered in this browser).
  // ---------------------------------------------------------------------------------------------
  const MUSIC_FILES = {
    0: "stone-age.ogg",
    1: "egypt.mp3",
    3: "middle-ages.mp3",
    4: "renaissance.ogg",
    6: "electric-age.mp3",
    7: "space-age.mp3",
    8: "digital-age.mp3",
    // The ruins replay the very first era's music, slowed down: the circle closing.
    13: { file: "stone-age.ogg", rate: 0.82 },
  };
  const MUSIC_LEVEL = 0.4; // music sits under the effects
  const MUSIC_FADE = 1.2; // seconds

  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI note -> Hz (timing never depends on it)
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function voice(out, t, { freq, dur, type = "sine", gain = 0.2, attack = 0.005, filter, detune = 0 }) {
    const ac = audio;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.setValueAtTime(detune, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (filter) {
      const f = ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(filter, t);
      osc.connect(f);
      node = f;
    }
    node.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  let noiseBuf = null;
  function hit(out, t, { dur, gain, freq, type = "highpass", q = 1 }) {
    const ac = audio;
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // Each composer gets the step number, its time, the output node and the step length.
  const COMPOSERS = {
    // Antiquity: a plucked lyre arpeggiating modal chords over a low drone, a stray melody above.
    2: {
      bpm: 72,
      perBeat: 2,
      step(i, t, out, sd) {
        const chords = [[62, 65, 69, 74], [57, 60, 64, 69], [60, 64, 67, 72], [62, 65, 69, 74]];
        const chord = chords[Math.floor(i / 16) % chords.length];
        if (i % 32 === 0) voice(out, t, { freq: NOTE(38), dur: sd * 34, gain: 0.07, attack: 1.5 });
        voice(out, t, { freq: NOTE(chord[i % 4]), dur: 1.4, type: "triangle", gain: 0.09, filter: 2400 });
        if (i % 4 === 2 && Math.random() < 0.55) {
          const scale = [74, 76, 77, 79, 81, 83, 84];
          voice(out, t, { freq: NOTE(pick(scale)), dur: 2.2, gain: 0.06, attack: 0.02 });
        }
      },
    },
    // Age of steam: a clockwork music box in 3/4 - bass, two chord ticks, bell melody, the gear.
    5: {
      bpm: 132,
      perBeat: 2,
      step(i, t, out, sd) {
        const bars = [[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]];
        const beat = Math.floor(i / 2) % 3;
        const chord = bars[Math.floor(i / 6) % bars.length];
        if (i % 2 === 0) {
          if (beat === 0) voice(out, t, { freq: NOTE(chord[0] - 24), dur: 0.5, type: "square", gain: 0.06, filter: 500 });
          else chord.forEach((n) => voice(out, t, { freq: NOTE(n), dur: 0.18, type: "triangle", gain: 0.035, filter: 1800 }));
          hit(out, t, { dur: 0.03, gain: 0.05, freq: 6000 });
        }
        if (Math.random() < 0.6) {
          const f = NOTE(pick(chord) + 24);
          voice(out, t, { freq: f, dur: 0.9, gain: 0.05 });
          voice(out, t, { freq: f * 3, dur: 0.25, gain: 0.012 });
        }
        if (i % 48 === 47) hit(out, t, { dur: 0.9, gain: 0.025, freq: 2500, type: "bandpass", q: 0.6 });
      },
    },
    // Cyberpunk: synthwave - filtered saw bass in octaves, a wide pad, kick/snare/hats, an arp.
    9: {
      bpm: 96,
      perBeat: 4,
      step(i, t, out, sd) {
        const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
        const chord = prog[Math.floor(i / 16) % prog.length];
        const s = i % 16;
        voice(out, t, { freq: NOTE(chord[0] - 12 + (s % 2 ? 12 : 0)), dur: sd * 0.9, type: "sawtooth", gain: 0.05, filter: 700 });
        if (s === 0) {
          chord.forEach((n) => [-8, 8].forEach((d) =>
            voice(out, t, { freq: NOTE(n), dur: sd * 16, type: "sawtooth", gain: 0.018, attack: 0.5, filter: 1400, detune: d })));
        }
        if (s % 8 === 0) voice(out, t, { freq: 140, dur: 0.25, gain: 0.25 });
        if (s % 8 === 4) hit(out, t, { dur: 0.18, gain: 0.12, freq: 1800, type: "bandpass", q: 0.8 });
        if (s % 4 === 2) hit(out, t, { dur: 0.05, gain: 0.05, freq: 8000 });
        if (s % 2 === 0 && Math.random() < 0.45) {
          voice(out, t, { freq: NOTE(pick(chord) + 12), dur: sd * 3, type: "triangle", gain: 0.04, filter: 3000 });
        }
      },
    },
  };

  // Solarpunk: a bright marimba over a soft pad, shakers.
  COMPOSERS[10] = {
    bpm: 100,
    perBeat: 2,
    step(i, t, out, sd) {
      const scale = [60, 62, 64, 67, 69, 72, 74, 76];
      const chords = [[60, 64, 67], [57, 60, 64], [65, 69, 72], [55, 59, 62]];
      const chord = chords[Math.floor(i / 16) % chords.length];
      if (i % 16 === 0) chord.forEach((n) => voice(out, t, { freq: NOTE(n - 12), dur: sd * 16, type: "triangle", gain: 0.03, attack: 0.6, filter: 900 }));
      if (Math.random() < 0.7) {
        const f = NOTE(i % 2 ? pick(scale) : pick(chord) + 12);
        voice(out, t, { freq: f, dur: 0.5, gain: 0.08, filter: 3000 });
        voice(out, t, { freq: f * 4, dur: 0.08, gain: 0.015 });
      }
      if (i % 2 === 1) hit(out, t, { dur: 0.06, gain: 0.03, freq: 7000 });
    },
  };
  // Mars: thin air - a low drone, wind, and far-off telemetry bleeps.
  COMPOSERS[11] = {
    bpm: 60,
    perBeat: 1,
    step(i, t, out, sd) {
      if (i % 8 === 0) {
        voice(out, t, { freq: NOTE(33), dur: sd * 9, gain: 0.08, attack: 2 });
        voice(out, t, { freq: NOTE(40), dur: sd * 9, gain: 0.04, attack: 3, detune: 6 });
      }
      if (i % 4 === 2) hit(out, t, { dur: sd * 3, gain: 0.02, freq: 500, type: "bandpass", q: 0.4 });
      if (Math.random() < 0.3) voice(out, t + Math.random() * sd, { freq: NOTE(pick([84, 88, 91, 96])), dur: 0.12, type: "square", gain: 0.012, filter: 4000 });
    },
  };
  // Quantum: glassy notes from a whole-tone scale, never quite settling.
  COMPOSERS[12] = {
    bpm: 84,
    perBeat: 2,
    step(i, t, out, sd) {
      const scale = [60, 62, 64, 66, 68, 70, 72, 74, 76, 78];
      if (i % 12 === 0) voice(out, t, { freq: NOTE(pick([36, 38, 40])), dur: sd * 12, gain: 0.05, attack: 1.5 });
      if (Math.random() < 0.55) {
        const f = NOTE(pick(scale));
        voice(out, t, { freq: f, dur: 2.4, gain: 0.05, attack: 0.02 });
        voice(out, t, { freq: f * 2.01, dur: 1.2, gain: 0.015 });
      }
    },
  };

  // Folk crafts: a plucked balalaika-like tune in a minor dance, with a soft stomp.
  COMPOSERS[14] = {
    bpm: 132,
    perBeat: 2,
    step(i, t, out, sd) {
      const chords = [[57, 60, 64], [57, 60, 64], [52, 55, 59], [57, 60, 64]];
      const chord = chords[Math.floor(i / 8) % chords.length];
      const s = i % 8;
      if (s % 4 === 0) {
        voice(out, t, { freq: NOTE(chord[0] - 12), dur: 0.3, type: "triangle", gain: 0.09, filter: 900 });
        hit(out, t, { dur: 0.08, gain: 0.05, freq: 180, type: "lowpass" });
      }
      if (s % 4 === 2) chord.forEach((n) => voice(out, t, { freq: NOTE(n), dur: 0.12, type: "sawtooth", gain: 0.02, filter: 2200 }));
      if (Math.random() < 0.6) {
        const f = NOTE(pick([69, 71, 72, 74, 76, 77, 79, 81]));
        // A balalaika's tremolo: the same note plucked twice in quick succession.
        voice(out, t, { freq: f, dur: 0.22, type: "sawtooth", gain: 0.03, filter: 2600 });
        voice(out, t + sd / 2, { freq: f, dur: 0.18, type: "sawtooth", gain: 0.02, filter: 2600 });
      }
    },
  };

  const music = (() => {
    const KEY = "tileFit.music";
    let enabled = readJsonEarly(KEY) !== false;
    let started = false;
    let eraNow = null;
    let current = null; // {stop(), setGain()}

    const level = () => vol() * MUSIC_LEVEL;

    function fileTrack(entry) {
      const name = typeof entry === "string" ? entry : entry.file;
      const el = new Audio("/sounds/tile-fit/" + name);
      el.loop = true;
      if (entry.rate) {
        el.preservesPitch = false;
        el.webkitPreservesPitch = false;
        el.playbackRate = entry.rate;
      }
      el.preload = "auto";
      el.volume = 0;
      el.play().catch(() => {});
      let target = level();
      const t0 = performance.now();
      const fadeIn = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / (MUSIC_FADE * 1000));
        el.volume = Math.min(1, target * k);
        if (k >= 1) clearInterval(fadeIn);
      }, 50);
      return {
        setGain(v) {
          target = v;
          el.volume = Math.min(1, v);
        },
        stop() {
          clearInterval(fadeIn);
          const from = el.volume;
          const t1 = performance.now();
          const out = setInterval(() => {
            const k = Math.min(1, (performance.now() - t1) / (MUSIC_FADE * 1000));
            el.volume = Math.max(0, from * (1 - k));
            if (k >= 1) {
              clearInterval(out);
              el.pause();
              el.removeAttribute("src");
              el.load();
            }
          }, 50);
        },
        pause: () => el.pause(),
        resume: () => el.play().catch(() => {}),
      };
    }

    function composedTrack(c) {
      const ac = ctx();
      if (!ac) return null;
      const out = ac.createGain();
      out.gain.setValueAtTime(0.0001, ac.currentTime);
      out.gain.exponentialRampToValueAtTime(Math.max(0.0001, level()), ac.currentTime + MUSIC_FADE);
      out.connect(ac.destination);
      const sd = 60 / c.bpm / c.perBeat;
      let i = 0;
      let next = ac.currentTime + 0.1;
      // Look-ahead scheduling: notes are queued a quarter second ahead on the audio clock, so a
      // busy main thread (a drag, a redraw) never makes the music stumble.
      const timer = setInterval(() => {
        if (ac.state !== "running") return;
        if (next < ac.currentTime) next = ac.currentTime + 0.05;
        while (next < ac.currentTime + 0.25) {
          c.step(i++, next, out, sd);
          next += sd;
        }
      }, 60);
      return {
        setGain(v) {
          out.gain.setTargetAtTime(Math.max(0.0001, v), ac.currentTime, 0.1);
        },
        stop() {
          clearInterval(timer);
          out.gain.setTargetAtTime(0.0001, ac.currentTime, MUSIC_FADE / 4);
          setTimeout(() => out.disconnect(), MUSIC_FADE * 1500);
        },
        pause() {},
        resume() {},
      };
    }

    function play() {
      if (current) current.stop();
      current = null;
      if (!started || !enabled || eraNow === null) return;
      current = MUSIC_FILES[eraNow] ? fileTrack(MUSIC_FILES[eraNow]) : COMPOSERS[eraNow] ? composedTrack(COMPOSERS[eraNow]) : null;
    }

    return {
      setEra(e) {
        if (e === eraNow) return;
        eraNow = e;
        play();
      },
      start() {
        if (started) return;
        started = true;
        play();
      },
      toggle() {
        enabled = !enabled;
        writeJsonEarly(KEY, enabled);
        play();
        return enabled;
      },
      isOn: () => enabled,
      updateVolume() {
        if (current) current.setGain(level());
      },
      pause() {
        if (current) current.pause();
      },
      resume() {
        if (current) current.resume();
      },
    };
  })();

  function readJsonEarly(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }
  function writeJsonEarly(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage blocked - the switch lasts for this tab only */
    }
  }

  const musicBtn = $("tf-music");
  function drawMusicButton() {
    musicBtn.setAttribute("aria-pressed", music.isOn() ? "true" : "false");
    musicBtn.classList.toggle("tf-btn-off", !music.isOn());
  }
  musicBtn.addEventListener("click", () => {
    ctx();
    music.start();
    music.toggle();
    drawMusicButton();
  });
  drawMusicButton();
  // The first press anywhere on the stage is the gesture that lets the music begin.
  root.addEventListener("pointerdown", () => music.start(), { capture: true });
  if (window.gameVolume) window.gameVolume.onChange(() => music.updateVolume());
  document.addEventListener("visibilitychange", () => (document.hidden ? music.pause() : music.resume()));

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
    // Secret levels are numbered past the main line and must not open it.
    solved.forEach((n) => {
      if (n <= LAST) m = Math.max(m, n);
    });
    return Math.min(LAST, m + 1);
  }

  const folkOpen = () => solved.has(FOLK_GATE);
  // The furthest folk level the player may open (0 = the branch is still closed).
  function folkMaxOpen() {
    if (!folkOpen()) return 0;
    let n = FOLK_FIRST;
    while (n < FOLK_LAST && solved.has(n)) n++;
    return n;
  }
  const isPlayable = (n) =>
    n === todayNumber() ||
    (n >= 1 && n <= maxOpen()) || (isFolk(n) && n <= folkMaxOpen()) || (isSecret(n) && foundSecretsEarly().has(n));
  function foundSecretsEarly() {
    return new Set(readJson("tileFit.secrets") || []);
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
        const st = (readJson(STARS_KEY) || {})[n] || 0;
        const sols = ((readJson(SOLUTIONS_KEY) || {})[n] || []).length;
        sub.textContent = (ornament ? I18N.special : fmt(I18N.levelLabel, { n })) +
          (st ? "  " + "★".repeat(st) + "☆".repeat(3 - st) : "") + (sols > 1 ? "  ◆" + sols : "");
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
    if (folkOpen()) {
      const box = document.createElement("div");
      box.className = "tf-map-era";
      const head = document.createElement("p");
      head.className = "tf-map-era-name";
      head.style.color = ERAS[FOLK_ERA].accent;
      head.textContent = I18N.eras[FOLK_ERA];
      box.appendChild(head);
      const top = folkMaxOpen();
      for (let n = FOLK_FIRST; n <= Math.min(FOLK_LAST, top + (top < FOLK_LAST && solved.has(top) ? 0 : 1)); n++) {
        const unknown = n > top;
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "tf-stop " + (unknown ? "tf-unknown" : solved.has(n) ? "tf-solved" : "tf-open") + (n === currentLevel ? " tf-current" : "");
        stop.style.setProperty("--x", Math.round(Math.sin(n * 1.3) * 70));
        stop.style.setProperty("--lc", unknown ? "#888" : ERAS[FOLK_ERA].accent);
        stop.innerHTML = '<span class="tf-stop-node"><span></span></span><span class="tf-stop-label"><span class="tf-stop-name"></span><span class="tf-stop-sub"></span></span>';
        stop.querySelector(".tf-stop-node span").textContent = unknown ? "?" : "✿";
        stop.querySelector(".tf-stop-name").textContent = unknown ? I18N.unknownLevel : levelName(n);
        if (unknown) stop.disabled = true;
        else {
          const st = (readJson(STARS_KEY) || {})[n] || 0;
          stop.querySelector(".tf-stop-sub").textContent = I18N.eras[FOLK_ERA] + (st ? "  " + "★".repeat(st) + "☆".repeat(3 - st) : "");
          stop.addEventListener("click", () => {
            closeMap();
            startLevel(n);
          });
        }
        box.appendChild(stop);
      }
      mapPath.appendChild(box);
    }
    if (foundSecrets.size) {
      const box = document.createElement("div");
      box.className = "tf-map-era";
      const head = document.createElement("p");
      head.className = "tf-map-era-name";
      head.textContent = I18N.secrets;
      box.appendChild(head);
      [...foundSecrets].sort((a, b) => a - b).forEach((n, i) => {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "tf-stop tf-special " + (solved.has(n) ? "tf-solved" : "tf-open");
        stop.style.setProperty("--x", Math.round(Math.sin(i * 1.7) * 70));
        stop.style.setProperty("--lc", ERAS[eraIndex(n)].accent);
        stop.innerHTML = '<span class="tf-stop-node"><span>✦</span></span><span class="tf-stop-label"><span class="tf-stop-name"></span><span class="tf-stop-sub"></span></span>';
        stop.querySelector(".tf-stop-name").textContent = levelName(n);
        stop.querySelector(".tf-stop-sub").textContent = I18N.secret;
        stop.addEventListener("click", () => {
          closeMap();
          startLevel(n);
        });
        box.appendChild(stop);
      });
      mapPath.appendChild(box);
    }
    {
      const box = document.createElement("div");
      box.className = "tf-map-era";
      box.innerHTML = '<p class="tf-map-era-name"></p><div class="tf-emote-boards"></div>';
      box.querySelector(".tf-map-era-name").textContent = I18N.emotesTitle;
      mapPath.appendChild(box);
      loadEmoteBoards(box.querySelector(".tf-emote-boards"));
    }
    $("tf-solved-count").textContent = fmt(I18N.solvedCount, { n: [...solved].filter((n) => n <= LAST).length });
  }

  // ---------------------------------------------------------------------------------------------
  // Secrets: three levels off the map, found by poking the scenery - the sun over Egypt, the
  // moon of the space age - or by honking the assembled clown's nose three times. Found ones are
  // remembered in this browser and get their own row on the map and room in the museum.
  // ---------------------------------------------------------------------------------------------
  const SECRETS_KEY = "tileFit.secrets";
  const foundSecrets = new Set((readJson(SECRETS_KEY) || []).filter((n) => isSecret(n)));
  let honks = 0;

  function discover(n) {
    const fresh = !foundSecrets.has(n);
    foundSecrets.add(n);
    writeJson(SECRETS_KEY, [...foundSecrets]);
    hideCard();
    startLevel(n);
    if (fresh) showSplash(n, I18N.secretFound, levelName(n));
  }
  root.querySelectorAll("[data-egg]").forEach((egg) => {
    egg.addEventListener("click", () => {
      if (cardOpen() || drag) return;
      const n = Number(egg.dataset.egg);
      if (L && eraIndex(L.level) === SECRET_ERA[n] && !isSecret(L.level)) discover(n);
    });
  });
  // Typing the four digits 4500 anywhere on the page (outside a text field) finds the amulet.
  let typed = "";
  window.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!/^[0-9]$/.test(e.key)) return;
    typed = (typed + e.key).slice(-4);
    if (typed === "4500") {
      typed = "";
      discover(4500);
    }
  });
  boardEl.addEventListener("click", (e) => {
    if (!e.target.classList || !e.target.classList.contains("tf-nose") || !solvedNow) return;
    tone({ type: "square", from: 330, to: 220, dur: 0.18, gain: 0.25 });
    tone({ type: "square", from: 336, to: 224, dur: 0.18, gain: 0.15 });
    if (++honks >= 3) {
      honks = 0;
      discover(1003);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Level of the day: one board per calendar date for everyone. Its result is kept here for
  // guests (fewest drops per day, and the run of consecutive days); for a logged-in player the
  // server keeps the same and ranks the day.
  // ---------------------------------------------------------------------------------------------
  const DAILY_KEY = "tileFit.daily";
  function prevDayNumber(n) {
    const d = new Date(Math.floor(n / 10000), (Math.floor(n / 100) % 100) - 1, n % 100);
    d.setDate(d.getDate() - 1);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function recordDailyLocally(day, moves) {
    const data = readJson(DAILY_KEY) || {};
    const best = data[day];
    if (!best || moves < best) data[day] = moves;
    writeJson(DAILY_KEY, data);
    let streak = 0;
    for (let d = day; data[d]; d = prevDayNumber(d)) streak++;
    return fmt(I18N.dailyLocal, { moves, streak });
  }
  $("tf-open-daily").addEventListener("click", () => {
    if (drag) return;
    closeMap();
    startLevel(todayNumber());
  });

  async function loadDailyTable() {
    const box = $("tf-daily-list");
    box.textContent = "";
    try {
      const res = await fetch("/games/tile-fit/daily.json?day=" + todayNumber(), { credentials: "same-origin" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      if (!json.rows.length) {
        const li = document.createElement("li");
        li.className = "tf-lb-empty";
        li.textContent = I18N.dailyEmpty;
        box.appendChild(li);
      }
      json.rows.forEach((row) => box.appendChild(lbRow({ ...row, score: row.moves }, false)));
      if (json.me && !json.rows.some((r) => r.isMe)) box.appendChild(lbRow({ ...json.me, score: json.me.moves }, true));
    } catch (_) {
      /* the table is a nicety; the main records still show */
    }
  }
  $("tf-open-records").addEventListener("click", loadDailyTable);

  // ---------------------------------------------------------------------------------------------
  // Emote boards: a hand-picked set of emotes, shrunk into boards by the server and listed under
  // "Смайлы" on the map; nothing about them is scored.
  // ---------------------------------------------------------------------------------------------
  const EMOTES_SOLVED_KEY = "tileFit.emotes";
  async function loadEmoteBoards(container) {
    container.textContent = "…";
    try {
      const res = await fetch("/games/tile-fit/emotes.json", { credentials: "same-origin" });
      const json = await res.json();
      container.textContent = "";
      if (!json.ok || !json.boards.length) {
        container.textContent = I18N.emotesNone;
        return;
      }
      const done = new Set(readJson(EMOTES_SOLVED_KEY) || []);
      const channel = json.channel;
      json.boards.forEach((b, i) => {
        const id = 5000 + i;
        customBoards.set(id, { emote: b.emote, channel, image: b.image });
        Engine.registerCustom(id, { mask: b.mask, colors: b.colors });
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "tf-stop " + (done.has(channel + ":" + b.emote) ? "tf-solved" : "tf-open");
        stop.style.setProperty("--x", Math.round(Math.sin(i * 1.4) * 60));
        stop.style.setProperty("--lc", ERAS[CUSTOM_ERA].accent);
        stop.innerHTML = '<span class="tf-stop-node"><img alt="" class="tf-stop-emote"></span><span class="tf-stop-label"><span class="tf-stop-name"></span></span>';
        stop.querySelector("img").src = b.image;
        stop.querySelector(".tf-stop-name").textContent = b.emote;
        stop.addEventListener("click", () => {
          closeMap();
          startLevel(id);
        });
        container.appendChild(stop);
      });
    } catch (_) {
      container.textContent = I18N.emotesNone;
    }
  }


  // ---------------------------------------------------------------------------------------------
  // Museum: every picture level of the eras reached so far. Assembled ones stand in the era's
  // colour with their features and their quote; the rest are dark silhouettes with no name.
  // Eras not reached yet are not in the building at all.
  // ---------------------------------------------------------------------------------------------
  const museumEl = $("tf-museum");
  const museumHall = $("tf-museum-hall");

  function miniFigure(level, assembled) {
    const NS = "http://www.w3.org/2000/svg";
    const L0 = Engine.generateLevel(level);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `-0.5 -0.5 ${L0.cols + 1} ${L0.rows + 1}`);
    svg.setAttribute("class", "tf-mini");
    const add = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
      svg.appendChild(e);
    };
    for (let r = 0; r < L0.rows; r++) {
      for (let c = 0; c < L0.cols; c++) {
        if (!L0.mask[r][c]) continue;
        const pic = assembled && Engine.figurePaint(L0.name);
        add("rect", { x: c, y: r, width: 1.02, height: 1.02, class: "tf-mini-cell", style: pic ? "fill:" + pic.palette[pic.paint[r][c]] : "" });
      }
    }
    if (assembled) {
      (L0.marks || []).forEach((m) => {
        if (m[0] === "dot") add("circle", { cx: m[2], cy: m[1], r: m[3], class: "tf-mini-mark", style: typeof m[4] === "string" ? "fill:" + m[4] : "" });
        else if (m[0] === "ring") add("ellipse", { cx: m[2], cy: m[1], rx: m[3], ry: m[4], class: "tf-mini-line" });
        else if (m[0] === "line") add("line", { x1: m[2], y1: m[1], x2: m[4], y2: m[3], class: "tf-mini-line" });
        else if (m[0] === "rect") add("rect", { x: m[2], y: m[1], width: m[4], height: m[3], class: "tf-mini-line" });
      });
    }
    return svg;
  }

  function renderMuseum() {
    museumHall.textContent = "";
    const reachedEra = eraIndex(maxOpen());
    const figs = [...Engine.figureLevels()].sort((a, b) => a[0] - b[0]);
    let have = 0;
    for (let e = 0; e <= Math.min(reachedEra, MAIN_ERAS - 1); e++) {
      const inEra = figs.filter(([lv]) => eraIndex(lv) === e);
      if (!inEra.length) continue;
      const room = document.createElement("section");
      room.className = "tf-museum-room";
      room.style.setProperty("--lc", ERAS[e].accent);
      const h = document.createElement("h3");
      h.className = "tf-museum-room-name";
      h.textContent = I18N.eras[e];
      const shelf = document.createElement("div");
      shelf.className = "tf-museum-shelf";
      room.append(h, shelf);
      inEra.forEach(([lv]) => {
        const got = solved.has(lv);
        if (got) have++;
        const card = document.createElement(got ? "button" : "div");
        card.className = "tf-exhibit" + (got ? "" : " tf-exhibit-unknown");
        card.appendChild(miniFigure(lv, got));
        const name = document.createElement("p");
        name.className = "tf-exhibit-name";
        name.textContent = got ? levelName(lv) : "?";
        card.appendChild(name);
        if (got) {
          const q = QUOTES[quoteIdFor(lv, 0)];
          if (q) {
            const qp = document.createElement("p");
            qp.className = "tf-exhibit-quote";
            qp.textContent = "«" + q.text + "» — " + q.author;
            card.appendChild(qp);
          }
          card.type = "button";
          card.title = fmt(I18N.levelLabel, { n: lv });
          card.addEventListener("click", () => {
            museumEl.hidden = true;
            startLevel(lv);
          });
        }
        shelf.appendChild(card);
      });
      museumHall.appendChild(room);
    }
    if (folkOpen()) {
      const room = document.createElement("section");
      room.className = "tf-museum-room";
      room.style.setProperty("--lc", ERAS[FOLK_ERA].accent);
      room.innerHTML = '<h3 class="tf-museum-room-name"></h3><div class="tf-museum-shelf"></div>';
      room.querySelector("h3").textContent = I18N.eras[FOLK_ERA];
      for (let lv = FOLK_FIRST; lv <= FOLK_LAST; lv++) {
        const got = solved.has(lv);
        if (got) have++;
        const card = document.createElement(got ? "button" : "div");
        card.className = "tf-exhibit" + (got ? "" : " tf-exhibit-unknown");
        card.appendChild(miniFigure(lv, got));
        const name = document.createElement("p");
        name.className = "tf-exhibit-name";
        name.textContent = got ? levelName(lv) : "?";
        card.appendChild(name);
        if (got) {
          card.type = "button";
          card.addEventListener("click", () => {
            museumEl.hidden = true;
            startLevel(lv);
          });
        }
        room.querySelector(".tf-museum-shelf").appendChild(card);
      }
      museumHall.appendChild(room);
    }
    if (foundSecrets.size) {
      const room = document.createElement("section");
      room.className = "tf-museum-room";
      room.style.setProperty("--lc", "#e9c46a");
      room.innerHTML = '<h3 class="tf-museum-room-name"></h3><div class="tf-museum-shelf"></div>';
      room.querySelector("h3").textContent = I18N.secrets;
      [...foundSecrets].sort((a, b) => a - b).forEach((lv) => {
        const got = solved.has(lv);
        if (got) have++;
        const card = document.createElement("button");
        card.type = "button";
        card.className = "tf-exhibit" + (got ? "" : " tf-exhibit-unknown");
        card.appendChild(miniFigure(lv, got));
        const name = document.createElement("p");
        name.className = "tf-exhibit-name";
        name.textContent = levelName(lv);
        card.appendChild(name);
        card.addEventListener("click", () => {
          museumEl.hidden = true;
          startLevel(lv);
        });
        room.querySelector(".tf-museum-shelf").appendChild(card);
      });
      museumHall.appendChild(room);
    }
    $("tf-museum-count").textContent = fmt(I18N.museumCount, { n: have });
  }
  $("tf-open-museum").addEventListener("click", () => {
    cancelDrag();
    renderMuseum();
    museumEl.hidden = false;
    museumEl.scrollTop = 0;
  });
  $("tf-close-museum").addEventListener("click", () => (museumEl.hidden = true));

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
  function showCard({ kicker, title, text, primary, onPrimary, secondary, onSecondary, quote, stars }) {
    const starBox = $("tf-card-stars");
    starBox.hidden = !stars;
    starBox.querySelectorAll(".tf-star").forEach((st, i) => st.classList.toggle("tf-star-on", !!stars && i < stars));
    const qBox = $("tf-card-quote");
    currentQuote = quote || null;
    qBox.hidden = !quote;
    if (quote) {
      $("tf-quote-text").textContent = quote.text;
      $("tf-quote-author").textContent = quote.author;
    }
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
    stopReading();
  }
  const cardOpen = () => !cardEl.hidden;

  // ---------------------------------------------------------------------------------------------
  // Play state
  // ---------------------------------------------------------------------------------------------
  let L = null; // the level from the engine
  // placed: {r, c} in the grid (always a fit); loose: {x, y} in cell units, unsnapped (never a
  // fit); at most one of the two is set, neither means "on the shelf".
  let pieces = []; // {i, cells, rot, placed, loose, color, el, slot}
  let history = [];
  let cs = 48; // board cell size, px
  let ts = 26; // shelf cell size, px
  let solvedNow = false;
  let mistakes = 0; // misplaced drops on this level, for the consolation quote
  let drops = 0; // every drop onto the board
  let takebacks = 0; // undos and resets
  let marksEl = null;
  let cellEls = []; // [r][c] -> the board cell, or null outside the figure
  let ghostEl = null; // the layer that shows where a held piece would land
  let ghostKey = ""; // what the ghost layer shows now, so an unchanged target touches nothing

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

  const snapshot = () => pieces.map((p) => ({
    rot: p.rot,
    placed: p.placed ? { ...p.placed } : null,
    loose: p.loose ? { ...p.loose } : null,
  }));

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 200) history.shift();
    undoBtn.disabled = false;
  }

  function restore(state) {
    state.forEach((s, i) => {
      pieces[i].rot = ((s.rot % 4) + 4) % 4;
      pieces[i].placed = s.placed ? { r: s.placed.r, c: s.placed.c } : null;
      pieces[i].loose = !s.placed && s.loose && Number.isFinite(s.loose.x) && Number.isFinite(s.loose.y)
        ? { x: s.loose.x, y: s.loose.y } : null;
    });
  }

  function saveBoard() {
    writeJson(BOARD_KEY, { level: L.level, version: L.version, pieces: snapshot() });
  }

  function setTitle(n) {
    $("tf-level-title").textContent = isSecret(n) ? I18N.secret : isFolk(n) ? I18N.folkLevel : isDaily(n) ? I18N.daily
      : isCustom(n) ? "#" + ((customBoards.get(n) || {}).channel || "") : fmt(I18N.levelLabel, { n });
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
    mistakes = 0;
    drops = 0;
    takebacks = 0;
    history = [];
    undoBtn.disabled = true;
    const era = applyTheme(n);
    music.setEra(eraIndex(n));
    pieces = L.pieces.map((pc, i) => ({
      i,
      cells: pc.cells,
      colors: pc.colors || null,
      rot: pc.startRotation,
      placed: null,
      loose: null,
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
    if (!isSecret(n) && (enteringEra || n === 1) && (n - 1) % 10 === 0 && !solved.has(n)) showSplash(n);
    else if (n === FOLK_FIRST && !solved.has(n)) showSplash(n);
  }

  function showSplash(n, kicker, name) {
    $("tf-splash-kicker").textContent = kicker || I18N.newEra;
    $("tf-splash-name").textContent = name || eraName(n);
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
    boardEl.className = boardEl.className.replace(/\btf-alive\S*/g, "").trim();
    boardEl.style.width = L.cols * cs + "px";
    boardEl.style.height = L.rows * cs + "px";
    cellEls = [];
    for (let r = 0; r < L.rows; r++) {
      cellEls.push(new Array(L.cols).fill(null));
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
        cellEls[r][c] = cell;
      }
    }
    drawMarks();
    // Where a held piece would land is drawn here, after the marks and before any piece: above
    // the cells and under the pieces, where the lit cells themselves used to be. Lighting a cell
    // in place repainted it and every piece over it (with their drop-shadows), on each change.
    ghostEl = document.createElement("div");
    ghostEl.className = "tf-ghost-layer";
    boardEl.appendChild(ghostEl);
    ghostKey = "";
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
      if (m[0] === "dot") {
        const eye = typeof m[4] !== "string" && m[3] >= 0.19 && m[3] <= 0.32;
        const nose = (L.figureKey || L.name) === "clown" && typeof m[4] === "string";
        el("circle", { cx: m[2], cy: m[1], r: m[3], fill: typeof m[4] === "string" ? m[4] : "currentColor", class: eye ? "tf-eye" : nose ? "tf-nose" : "" });
      }
      else if (m[0] === "ring") el("ellipse", { cx: m[2], cy: m[1], rx: m[3], ry: m[4], ...stroke });
      else if (m[0] === "line") el("line", { x1: m[2], y1: m[1], x2: m[4], y2: m[3], ...stroke });
      else if (m[0] === "rect") el("rect", { x: m[2], y: m[1], width: m[4], height: m[3], rx: 0.15, ...stroke });
    });
    boardEl.appendChild(svg);
    marksEl = svg;
  }

  // The piece's cells after its turns, each still knowing which original cell it is - a picture
  // piece paints every cell its own colour, and the colour has to follow the cell round.
  function cellsWithIndex(p) {
    let out = p.cells.map(([r, c], i) => [r, c, i]);
    for (let k = 0; k < p.rot; k++) out = out.map(([r, c, i]) => [c, -r, i]);
    let minR = Infinity;
    let minC = Infinity;
    out.forEach(([r, c]) => {
      minR = Math.min(minR, r);
      minC = Math.min(minC, c);
    });
    return out.map(([r, c, i]) => [r - minR, c - minC, i]);
  }

  function drawPiece(p, size) {
    const cells = cellsWithIndex(p);
    const set = new Set(cells.map(([r, c]) => r + ":" + c));
    const d = dims(cells);
    p.el.textContent = "";
    p.el.style.width = d.w * size + "px";
    p.el.style.height = d.h * size + "px";
    cells.forEach(([r, c, idx]) => {
      const pc = document.createElement("div");
      pc.className = "tf-pcell";
      if (p.colors && p.colors[idx]) pc.style.setProperty("--tf-pc", p.colors[idx]);
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
    p.el.classList.toggle("tf-loose", !!p.loose);
    p.el.style.transform = ""; // the drag offset, see moveDrag
    if (p.placed || p.loose) {
      const x = p.placed ? p.placed.c : p.loose.x;
      const y = p.placed ? p.placed.r : p.loose.y;
      drawPiece(p, cs);
      p.el.style.left = x * cs + "px";
      p.el.style.top = y * cs + "px";
      // A loose piece is re-appended so the last one dropped lies on top.
      if (p.loose || p.el.parentNode !== boardEl) boardEl.appendChild(p.el);
      p.slot.classList.add("tf-empty");
    } else {
      drawPiece(p, ts);
      p.el.style.left = "";
      p.el.style.top = "";
      if (p.el.parentNode !== p.slot) p.slot.appendChild(p.el);
      p.slot.classList.remove("tf-empty");
    }
  }

  // Grid cells taken by pieces in the grid, optionally leaving one piece out.
  function takenCells(except) {
    const taken = new Set();
    pieces.forEach((p) => {
      if (p.placed && p !== except) shapeOf(p).forEach(([dr, dc]) => taken.add(p.placed.r + dr + ":" + (p.placed.c + dc)));
    });
    return taken;
  }

  function fitsAt(cells, r0, c0, except) {
    const taken = takenCells(except);
    return cells.every(([dr, dc]) => {
      const r = r0 + dr;
      const c = c0 + dc;
      return r >= 0 && r < L.rows && c >= 0 && c < L.cols && L.mask[r][c] && !taken.has(r + ":" + c);
    });
  }

  function renderAll() {
    pieces.forEach(seat);
    validate();
    updateStatus();
  }

  // Grid pieces never clash (they only get there by fitting), so only loose pieces are marked: the
  // cells that would collide at the nearest grid spot turn red. Solved = the grid is full.
  function validate() {
    const taken = takenCells(null);
    pieces.forEach((p) => {
      p.el.classList.toggle("tf-invalid", !!p.loose);
      if (!p.loose) {
        p.el.querySelectorAll(".tf-bad").forEach((e) => e.classList.remove("tf-bad"));
        return;
      }
      const r0 = Math.round(p.loose.y);
      const c0 = Math.round(p.loose.x);
      p.el.querySelectorAll(".tf-pcell").forEach((pc) => {
        const r = r0 + Number(pc.dataset.r);
        const c = c0 + Number(pc.dataset.c);
        const off = r < 0 || r >= L.rows || c < 0 || c >= L.cols || !L.mask[r][c];
        pc.classList.toggle("tf-bad", off || taken.has(r + ":" + c));
      });
    });
    return { complete: taken.size === L.area };
  }

  const isPieceValid = (p) => !!p.placed;

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
  // A piece on the board turns around the cell that was clicked: that cell stays exactly where it
  // is, so four turns bring the piece back to the same spot. (Turning around the middle meant
  // rounding a half-cell offset every time, and the piece walked away a cell per turn.)
  function rotatePiece(p, pivot) {
    if (solvedNow) return;
    pushHistory();
    const before = dims(shapeOf(p));
    p.rot = (p.rot + 1) % 4;
    if (p.placed || p.loose) {
      const pv = pivot || { r: Math.floor((before.h - 1) / 2), c: Math.floor((before.w - 1) / 2) };
      // Clockwise, local (r, c) becomes (c, h - 1 - r).
      const dy = pv.r - pv.c;
      const dx = pv.c - (before.h - 1 - pv.r);
      const y = (p.placed ? p.placed.r : p.loose.y) + dy;
      const x = (p.placed ? p.placed.c : p.loose.x) + dx;
      const r = Math.round(y);
      const c = Math.round(x);
      if (fitsAt(shapeOf(p), r, c, p)) {
        p.placed = { r, c };
        p.loose = null;
      } else {
        p.placed = null;
        p.loose = { x, y };
      }
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
  // A drag step costs nothing but a compositor move. The held piece sits at left/top 0 in the
  // fixed drag layer and travels by transform, in a layer of its own (will-change in the
  // stylesheet), so it is painted once when lifted and never again while it moves; left/top
  // relaid the page and repainted the piece - textures, rivets, drop-shadow - on every event.
  // Pointer events are folded into one update per animation frame (a phone can deliver them
  // faster than it draws), the board's position is read once per drag rather than once per
  // event, and the landing spot is drawn on its own layer and only when it changes. Measured in
  // Chromium at 390x844 @3x with the CPU slowed 6x (Playwright's WebKit on Windows does not
  // composite, so it cannot show this part): a drag step on level 35 went from a 66 ms median
  // to 33 ms, which is the two-frame floor of the measurement itself.
  let press = null; // {p, x, y, id}
  let drag = null; // {p, id, fx, fy, x, y, br, before}
  let lastDragEnd = 0;
  let dragFrame = 0;

  // The clicked cell in the piece's own coordinates, for turning around it.
  function cellFromEvent(e) {
    const pc = e.target.closest && e.target.closest(".tf-pcell");
    return pc ? { r: Number(pc.dataset.r), c: Number(pc.dataset.c) } : null;
  }

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
      rotatePiece(p, cellFromEvent(e));
      return;
    }
    if (e.button !== 0) return;
    press = { p, x: e.clientX, y: e.clientY, id: e.pointerId, cell: cellFromEvent(e) };
  });

  window.addEventListener("pointermove", (e) => {
    // The right button pressed while the left is held arrives as a pointermove (a chorded button
    // change), not as a pointerdown: it turns the held piece - lifting it first if it was only
    // pressed and not yet dragged.
    if (e.button === 2 && e.buttons & 2 && e.buttons & 1) {
      if (press && e.pointerId === press.id) {
        beginDrag(press, e.clientX, e.clientY);
        press = null;
      }
      if (drag && e.pointerId === drag.id) {
        rotateDragged();
        return;
      }
    }
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
      const { p, cell } = press;
      press = null;
      rotatePiece(p, cell);
    }
  });

  window.addEventListener("pointercancel", () => {
    press = null;
    cancelDrag();
  });

  function beginDrag(pr, x, y) {
    const p = pr.p;
    const rect = p.el.getBoundingClientRect();
    const cur = p.placed || p.loose ? cs : ts;
    drag = {
      p,
      id: pr.id,
      // Where on the piece it was grabbed, in cells - kept under the pointer as it grows from
      // shelf size to board size.
      fx: (pr.x - rect.left) / cur,
      fy: (pr.y - rect.top) / cur,
      x,
      y,
      br: boardEl.getBoundingClientRect(),
      before: snapshot(),
    };
    drawPiece(p, cs);
    p.el.classList.remove("tf-shake", "tf-pop", "tf-invalid");
    p.el.querySelectorAll(".tf-bad").forEach((c) => c.classList.remove("tf-bad"));
    p.el.style.left = "0px";
    p.el.style.top = "0px";
    dragLayer.appendChild(p.el);
    if (p.placed || p.loose) {
      p.placed = null;
      p.loose = null;
      validate();
    }
    p.slot.classList.add("tf-empty");
    sfx.pick();
    applyDrag();
  }

  // Remembers where the pointer is and draws it with the next frame.
  function moveDrag(x, y) {
    drag.x = x;
    drag.y = y;
    if (!dragFrame) dragFrame = requestAnimationFrame(applyDrag);
  }

  function applyDrag() {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (!drag) return;
    const left = drag.x - drag.fx * cs;
    const top = drag.y - drag.fy * cs;
    drag.p.el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    drawGhost();
  }

  // The page can scroll under a held piece (a wheel turns it, but a pinch or the browser's own
  // chrome can still move things); the cached board position follows.
  const refreshBoardRect = () => {
    if (drag) drag.br = boardEl.getBoundingClientRect();
  };
  window.addEventListener("scroll", refreshBoardRect, { capture: true, passive: true });
  window.addEventListener("resize", refreshBoardRect, { passive: true });

  function snapTarget() {
    const br = drag.br;
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
    if (!ghostKey) return;
    ghostKey = "";
    if (ghostEl) ghostEl.textContent = "";
  }

  function drawGhost() {
    const t = snapTarget();
    if (!t.onBoard) {
      clearGhost();
      return;
    }
    const taken = takenCells(drag.p);
    let fits = true;
    const targets = [];
    t.cells.forEach(([dr, dc]) => {
      const r = t.r + dr;
      const c = t.c + dc;
      if (r < 0 || r >= L.rows || c < 0 || c >= L.cols || !L.mask[r][c] || taken.has(r + ":" + c)) fits = false;
      if (cellEls[r] && cellEls[r][c]) targets.push([r, c]);
    });
    const key = (fits ? "ok" : "bad") + targets.join(";");
    if (key === ghostKey) return;
    ghostKey = key;
    ghostEl.textContent = "";
    // Each highlight is a lit copy of the cell it covers (same material, same texture offset), so
    // it looks exactly like the cell itself lighting up, while the cell is never touched.
    targets.forEach(([r, c]) => {
      const g = cellEls[r][c].cloneNode(false);
      g.classList.add(fits ? "tf-ghost-ok" : "tf-ghost-bad");
      ghostEl.appendChild(g);
    });
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
    applyDrag(); // now, not next frame: the redrawn shape must not show one frame at the old offset
  }

  function endDrag(x, y) {
    drag.x = x;
    drag.y = y;
    drag.br = boardEl.getBoundingClientRect();
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    const p = drag.p;
    const t = snapTarget();
    const br = drag.br;
    const looseAt = { x: (x - drag.fx * cs - br.left) / cs, y: (y - drag.fy * cs - br.top) / cs };
    history.push(drag.before);
    if (history.length > 200) history.shift();
    undoBtn.disabled = false;
    drag = null;
    clearGhost();
    lastDragEnd = Date.now();
    if (t.onBoard) {
      drops++;
      if (fitsAt(t.cells, t.r, t.c, p)) {
        p.placed = { r: t.r, c: t.c };
        p.loose = null;
      } else {
        p.placed = null;
        p.loose = looseAt;
        mistakes++;
      }
      seat(p);
      afterChange(p);
    } else {
      p.placed = null;
      p.loose = null;
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

  // No context menu over the game, and none from a right button released just after the left one
  // let a piece go.
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("contextmenu", (e) => {
    if (drag || Date.now() - lastDragEnd < 600) e.preventDefault();
  });

  // ---------------------------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------------------------
  function undo() {
    if (solvedNow || drag || cardOpen() || !history.length) return;
    takebacks++;
    restore(history.pop());
    undoBtn.disabled = history.length === 0;
    renderAll();
    saveBoard();
    sfx.back();
  }

  function resetBoard() {
    if (solvedNow || drag) return;
    takebacks++;
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

    // A picture can be covered in more layouts than the one it was cut into; whichever the player
    // found, the painting settles into place once the board is full - every cell takes the colour
    // of the spot it covers.
    const painting = Engine.figurePaint(L.custom ? L.name : L.figureKey || L.name);
    if (painting) {
      pieces.forEach((p) => {
        p.el.querySelectorAll(".tf-pcell").forEach((pc) => {
          const r = p.placed.r + Number(pc.dataset.r);
          const c = p.placed.c + Number(pc.dataset.c);
          const colour = painting.palette[painting.paint[r][c]];
          if (colour) {
            pc.style.transition = "background-color 0.8s ease " + (r + c) * 40 + "ms";
            pc.style.setProperty("--tf-pc", colour);
          }
        });
      });
    }

    const pictureKey = L.figureKey || L.name;
    const isPicture = !!L.figureKey || !!L.secret || !!L.custom;
    if (isPicture) {
      setTimeout(() => {
        if (!solvedNow) return;
        boardEl.classList.add("tf-alive", "tf-alive-" + motionOf(pictureKey));
        if (BLINKERS.has(pictureKey)) boardEl.classList.add("tf-alive-blink");
      }, 1100);
    }

    const stars = mistakes > 0 ? 1 : takebacks === 0 && drops === pieces.length ? 3 : 2;
    const allStars = readJson(STARS_KEY) || {};
    const prevStars = allStars[L.level] || 0;
    if (stars > prevStars) {
      allStars[L.level] = stars;
      writeJson(STARS_KEY, allStars);
    }
    const sig = pieces.map((p) => shapeOf(p).map(([r, c]) => (p.placed.r + r) + "." + (p.placed.c + c)).join(",")).sort().join("|");
    const allSol = readJson(SOLUTIONS_KEY) || {};
    const known = allSol[L.level] || [];
    const newSolution = !known.includes(sig) && known.length > 0;
    if (!known.includes(sig)) {
      known.push(sig);
      allSol[L.level] = known.slice(-MAX_SOLUTIONS_KEPT);
      writeJson(SOLUTIONS_KEY, allSol);
    }

    const first = !solved.has(L.level);
    const counted = !isDaily(L.level) && !isCustom(L.level);
    if (counted) {
      solved.add(L.level);
      persistSolved();
    }
    let dailyText = "";
    if (isCustom(L.level) && customBoards.has(L.level)) {
      const cb = customBoards.get(L.level);
      const done = new Set(readJson(EMOTES_SOLVED_KEY) || []);
      done.add(cb.channel + ":" + cb.emote);
      writeJson(EMOTES_SOLVED_KEY, [...done]);
    }
    if (isDaily(L.level)) dailyText = recordDailyLocally(L.level, drops);
    writeJson(BOARD_KEY, null);

    // Only the very last main level ends the game; secrets, the folk branch's end, the level of the
    // day and emote boards are numbered past it but merely have no "next".
    const finale = L.level === LAST;
    const last = finale || isSecret(L.level) || L.level === FOLK_LAST;
    const noNext = last || isDaily(L.level) || isCustom(L.level);
    const isFigure = isPicture;
    const level = L.level;
    setTimeout(() => {
      if (!solvedNow || L.level !== level) return;
      showCard({
        // The same line the level's header shows - a secret, a craft, a channel's emote or the level
        // of the day has no number the player should see.
        kicker: $("tf-level-title").textContent,
        title: isFigure ? fmt(I18N.figureDone, { name: levelName(level) }) : I18N.solvedTitle,
        text: dailyText ? dailyText : finale ? I18N.allSolved : newSolution ? fmt(I18N.newSolution, { n: known.length }) : "",
        stars,
        primary: noNext ? "" : I18N.next,
        onPrimary: () => startLevel(level + 1),
        secondary: I18N.toLevels,
        onSecondary: openMap,
        quote: QUOTES[quoteIdFor(level, mistakes)],
      });
      if (DATA.loggedIn && !isCustom(level)) submit(L, first);
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
      moves: String(drops),
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
      if (json.daily) {
        textEl.textContent = fmt(I18N.dailyResult, { rank: json.daily.me ? json.daily.me.rank : "—", moves: drops, streak: json.daily.streak });
        return;
      }
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
  rasterizeTextures();
  const savedBoard = readJson(BOARD_KEY);
  if (savedBoard && savedBoard.version === Engine.LEVELS_VERSION && isPlayable(savedBoard.level)) {
    startLevel(savedBoard.level);
  } else {
    startLevel(maxOpen());
  }
})();
