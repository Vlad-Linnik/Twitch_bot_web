// "Укладка" (/games/tile-fit): a board and a set of pieces that cover it exactly. Pure and I/O-free,
// loaded by both the browser (public/js/games/tile-fit.js) and the server (routes/tileFit.js), the
// same split as the other engines in this folder: the browser builds the level it draws from this
// file, and the server rebuilds the very same level from the same file to check a submitted
// solution. Two generators would drift, and a drift here means an honest solution rejected.
//
// Levels are not stored anywhere - each one is generated from its number. That is what keeps a
// hundred hand-tuned-looking puzzles at zero bytes of data, and it is also why everything below is
// integer arithmetic plus IEEE +-*/ and comparisons: nothing transcendental (Math.sin/pow/exp can
// differ in the last bit between V8 and another browser), no Math.random, no unstable ordering.
// Changing ANY constant or step here changes the levels themselves - bump LEVELS_VERSION, and know
// that a player's half-finished board on the old version will no longer line up.
//
// Every level is solvable by construction: the board is cut into pieces, and the pieces are what
// the player gets. Difficulty is a straight line in the level number - board area grows from 8 to
// about 70 cells and the piece sizes step up from dominoes to pentominoes - and the board stops
// being a plain rectangle early on.
"use strict";

const LEVEL_COUNT = 100;
const LEVELS_VERSION = 1;
const MAX_SIDE = 10;
const SALT = 0x5eed7f17;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, n) {
  return Math.floor(rng() * n);
}

// ---------------------------------------------------------------------------
// Board shapes. Each takes a width and height and answers "is cell (r, c) part of the board".
// ---------------------------------------------------------------------------

const SHAPES = {
  rect: () => true,
  cornerCut: (r, c, w, h) => {
    if (w < 4 || h < 4) return true;
    const edgeR = r === 0 || r === h - 1;
    const edgeC = c === 0 || c === w - 1;
    return !(edgeR && edgeC);
  },
  octagon: (r, c, w, h) => {
    const k = Math.max(1, Math.floor(Math.min(w, h) / 4));
    const dr = Math.min(r, h - 1 - r);
    const dc = Math.min(c, w - 1 - c);
    return dr + dc >= k;
  },
  plus: (r, c, w, h) => {
    const bw = Math.max(2, Math.round((w * 2) / 5));
    const bh = Math.max(2, Math.round((h * 2) / 5));
    const c0 = Math.floor((w - bw) / 2);
    const r0 = Math.floor((h - bh) / 2);
    return (c >= c0 && c < c0 + bw) || (r >= r0 && r < r0 + bh);
  },
  ring: (r, c, w, h) => {
    if (w < 6 || h < 6) return true;
    return r < 2 || r >= h - 2 || c < 2 || c >= w - 2;
  },
  ell: (r, c, w, h) => !(c >= Math.ceil(w / 2) && r < Math.floor(h / 2)),
  tee: (r, c, w, h) => {
    const sw = Math.max(2, Math.round((w * 2) / 5));
    const c0 = Math.floor((w - sw) / 2);
    return r < Math.max(2, Math.round(h / 4)) || (c >= c0 && c < c0 + sw);
  },
  arch: (r, c, w, h) => {
    const nw = Math.max(1, Math.round(w / 3));
    const c0 = Math.floor((w - nw) / 2);
    return !(c >= c0 && c < c0 + nw && r >= Math.ceil(h / 2));
  },
  stairs: (r, c, w, h) => c * h < (r + 1) * w + h,
  diamond: (r, c, w, h) => {
    // |x|/(w/2) + |y|/(h/2) <= 1.05, on cell centres, scaled up to integers.
    const x = Math.abs(2 * c + 1 - w) * h;
    const y = Math.abs(2 * r + 1 - h) * w;
    return (x + y) * 20 <= w * h * 21;
  },
  heart: (r, c, w, h) => {
    // Two round lobes over a downward point, on cell centres mapped to [-1, 1].
    const x = (2 * c + 1 - w) / w;
    const y = (2 * r + 1 - h) / h;
    const lx = Math.abs(x) - 0.5;
    const ly = y + 0.45;
    if (lx * lx + ly * ly <= 0.3) return true;
    return y >= -0.45 && Math.abs(x) * 1.45 <= 1 - y;
  },
  zigzag: (r, c, w, h) => {
    const half = Math.floor(h / 2);
    const shift = Math.max(1, Math.floor(w / 4));
    return r < half ? c < w - shift : c >= shift;
  },
  hourglass: (r, c, w, h) => {
    const mid = (h - 1) / 2;
    const d = Math.abs(r - mid);
    const inset = Math.floor((mid - d) * (w / 2 - 1) / Math.max(1, mid));
    return c >= inset && c < w - inset;
  },
};

// Plain rectangles carry the first levels; after that every shape takes its turn, with a
// rectangle reappearing now and then as a breather.
const SHAPE_CYCLE = [
  "cornerCut", "ell", "rect", "tee", "plus", "arch", "stairs", "octagon",
  "zigzag", "rect", "diamond", "ring", "hourglass", "heart",
];

function shapeFor(level) {
  if (level <= 6) return "rect";
  return SHAPE_CYCLE[(level - 7) % SHAPE_CYCLE.length];
}

// ---------------------------------------------------------------------------
// Figures: levels whose board is a picture - the player is assembling a piggy, a house, a rocket.
// The silhouette is the board; `marks` are the features (eyes, snout, door) drawn over it, in
// cell units where cell (r, c) spans [r, r+1] x [c, c+1]:
//   ["dot", r, c, radius, colour?]   ["ring", r, c, rx, ry]   ["line", r1, c1, r2, c2]   ["rect", r, c, h, w]
// A figure goes to the level whose planned area is closest to its own, so pictures do not bend
// the difficulty line; see figureLevels().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Every tenth level closes its era with an ornament for a board - an emblem of that era, holes
// and all: a sun cross, an eye, a Greek key, a rose window, a dome, a flywheel, an art-deco fan,
// a cratered planet, a microchip, a core. The rules stay the same; only the board is special.
// Each is drawn near the area the straight difficulty line plans for its level.
// ---------------------------------------------------------------------------

const ORNAMENTS = {
  10: { key: "sunStone", rows: ["..#..", ".###.", "##.##", ".###.", "..#.."] },
  20: { key: "eye", rows: ["..####..", ".##..##.", "###..###", ".##..##.", "..####.."] },
  30: { key: "meander", rows: ["#######", "#.....#", "#.###.#", "#.#...#", "#.#####"] },
  40: { key: "roseWindow", rows: ["..###..", ".#####.", "##.#.##", "#######", "##.#.##", ".#####.", "..###.."] },
  50: { key: "dome", rows: ["....#....", "..#####..", ".#######.", "#########", "#.##.##.#", "#.##.##.#", "#########"] },
  60: { key: "flywheel", rows: ["...###...", ".#.###.#.", ".#######.", "###...###", "###...###", "###...###", ".#######.", ".#.###.#.", "...###..."] },
  70: { key: "fan", rows: ["#...#...#", "##..#..##", ".##.#.##.", "..#####..", "#########", "#########", "#########", ".#######."] },
  80: { key: "planet", rows: ["...####...", "..######..", ".###.####.", "##########", "####.#####", ".#####.##.", "..######..", "...####..."] },
  90: { key: "chip", rows: [".#.#.#.#.", "#########", ".#######.", "##.###.##", ".#######.", "##.###.##", ".#######.", "#########", ".#.#.#.#."] },
  100: { key: "core", rows: [".########.", "##......##", "#..####..#", "#.######.#", "####..##.#", "#.##..####", "#.######.#", "#..####..#", "##......##", ".########."] },
};

const rowsToMask = (rows) => rows.map((row) => [...row].map((ch) => (ch === "#" ? 1 : 0)));

const FIGURES = {
  piggy: {
    rows: ["##.....##", "###...###", "#########", "#########", "#########", "#########", ".#######.", "..#####.."],
    marks: [["dot", 2.7, 2.5, 0.28], ["dot", 2.7, 6.5, 0.28], ["ring", 4.7, 4.5, 1.35, 0.85], ["dot", 4.7, 4.05, 0.17], ["dot", 4.7, 4.95, 0.17]],
  },
  house: {
    rows: ["..#..", ".###.", "#####", ".###.", ".###."],
    marks: [["rect", 3.25, 2.0, 1.75, 1.0], ["dot", 1.6, 2.5, 0.2]],
  },
  cat: {
    rows: ["#.....#", "##...##", "#######", "#######", "#######", ".#####."],
    marks: [["dot", 2.6, 2.0, 0.26], ["dot", 2.6, 5.0, 0.26], ["dot", 3.6, 3.5, 0.18],
      ["line", 3.8, 0.5, 4.0, 2.4], ["line", 4.4, 0.6, 4.2, 2.4], ["line", 3.8, 6.5, 4.0, 4.6], ["line", 4.4, 6.4, 4.2, 4.6]],
  },
  fish: {
    rows: ["..###...#", ".#####.##", "#########", ".#####.##", "..###...#"],
    marks: [["dot", 1.8, 2.0, 0.24], ["line", 1.2, 3.6, 3.8, 3.6]],
  },
  mushroom: {
    rows: ["..####..", ".######.", "########", "########", "...##...", "...##...", "..####.."],
    marks: [["dot", 1.0, 3.0, 0.32], ["dot", 1.5, 5.6, 0.28], ["dot", 2.7, 1.6, 0.3], ["dot", 3.0, 4.2, 0.26], ["dot", 2.6, 6.6, 0.24]],
  },
  tree: { rows: ["...#...", "..###..", ".#####.", "..###..", ".#####.", "#######", "...#...", "...#..."], marks: [] },
  rocket: {
    rows: ["..##..", ".####.", ".####.", ".####.", ".####.", "######", "##..##"],
    marks: [["ring", 2.4, 3.0, 0.7, 0.7]],
  },
  ghost: {
    rows: [".#####.", "#######", "#######", "#######", "#######", "#.#.#.#"],
    marks: [["dot", 2.3, 2.4, 0.3], ["dot", 2.3, 4.6, 0.3], ["ring", 3.8, 3.5, 0.45, 0.6]],
  },
  crown: {
    rows: ["#..#..#", "##.#.##", "#######", "#######", "#######"],
    marks: [["dot", 3.5, 1.5, 0.25], ["dot", 3.5, 3.5, 0.3], ["dot", 3.5, 5.5, 0.25]],
  },
  mug: { rows: ["######..", "########", "######.#", "######.#", "########", "######..", ".####..."], marks: [] },
  key: { rows: [".###......", "##.##.....", ".#########", "......#.#."], marks: [] },
  anchor: { rows: ["..####..", "..#..#..", "..####..", "########", "...##...", "#..##..#", "##.##.##", ".######.", "..####.."], marks: [] },
  star: { rows: ["....#....", "...###...", "#########", ".#######.", "..#####..", ".###.###.", ".##...##."], marks: [] },
  apple: { rows: [".....#..", ".....#..", ".###.##.", "########", "########", "########", ".######.", "..##.##."], marks: [] },
  butterfly: {
    rows: ["##.....##", "###...###", "####.####", ".#######.", "...###...", ".#######.", "####.####", "###...###"],
    marks: [["line", 2.6, 4.5, 7.0, 4.5], ["line", 0.3, 3.4, 2.6, 4.4], ["line", 0.3, 5.6, 2.6, 4.6]],
  },
  plane: { rows: ["....#.....", "....##....", "#...##....", "##########", "#...##....", "....##....", "....#....."], marks: [] },
  doggy: {
    rows: ["##.....##", "###...###", ".#######.", ".#######.", ".#######.", "..#####..", "...###..."],
    marks: [["dot", 2.8, 3.0, 0.26], ["dot", 2.8, 6.0, 0.26], ["dot", 4.4, 4.5, 0.42], ["line", 4.9, 4.5, 5.6, 4.5]],
  },
  umbrella: { rows: ["...###...", ".#######.", "#########", "#.#.#.#.#", "....#....", "....#....", "....#....", "..###...."], marks: [] },
  boat: { rows: ["....#....", "....##...", "....###..", "....####.", "....#....", "#########", ".#######.", "..#####.."], marks: [] },
  robot: {
    rows: ["....#....", "..#####..", "..#####..", "..#####..", "...###...", "#########", "#.#####.#", "#.#####.#", "..##.##..", "..##.##.."],
    marks: [["dot", 2.0, 3.6, 0.3], ["dot", 2.0, 5.4, 0.3], ["line", 3.4, 3.4, 3.4, 5.6], ["dot", 0.4, 4.5, 0.2]],
  },
  cactus: { rows: ["...##...", "...##...", "#..##...", "#..##..#", "######.#", "...#####", "...##...", "...##..."], marks: [] },
  castle: {
    rows: ["#.#....#.#", "###....###", "###.##.###", "###.##.###", "##########", "##########", "##########", "##########"],
    marks: [["rect", 6.0, 4.0, 2.0, 2.0], ["dot", 5.0, 1.5, 0.25], ["dot", 5.0, 8.5, 0.25]],
  },
  elephant: {
    rows: [".####.....", "######....", "########..", "#########.", "#########.", "#..######.", "#..##..##.", "#..##..##."],
    marks: [["dot", 2.4, 3.2, 0.26], ["ring", 3.0, 5.6, 1.1, 1.3]],
  },
  whale: {
    rows: [".........#", "........##", ".######..#", "##########", "##########", "#########.", ".#######.."],
    marks: [["dot", 4.0, 1.8, 0.26], ["line", 4.8, 0.7, 5.2, 3.0]],
  },

  frog: {
    rows: [".##.##.", "#######", "#######", "#######", ".#####."],
    marks: [["dot", 0.9, 1.5, 0.26], ["dot", 0.9, 4.5, 0.26], ["line", 3.0, 1.5, 3.5, 3.5], ["line", 3.5, 3.5, 3.0, 5.5]],
  },
  owl: {
    rows: ["#.....#", "##...##", "#######", "#######", "#######", "#######", ".#####.", "..#.#.."],
    marks: [["ring", 3.0, 2.0, 0.75, 0.75], ["ring", 3.0, 5.0, 0.75, 0.75], ["dot", 3.0, 2.0, 0.25], ["dot", 3.0, 5.0, 0.25], ["dot", 4.2, 3.5, 0.25]],
  },
  penguin: {
    rows: ["..###..", ".#####.", ".#####.", "#######", "#######", ".#####.", ".#####.", ".##.##."],
    marks: [["dot", 1.6, 2.7, 0.2], ["dot", 1.6, 4.3, 0.2], ["dot", 2.3, 3.5, 0.25], ["ring", 5.0, 3.5, 1.5, 2.2]],
  },
  bunny: {
    rows: [".#...#.", ".#...#.", ".##.##.", ".#####.", "#######", "#######", ".#####."],
    marks: [["dot", 4.4, 2.4, 0.25], ["dot", 4.4, 4.6, 0.25], ["dot", 5.3, 3.5, 0.2], ["line", 5.5, 1.2, 5.4, 2.6], ["line", 5.5, 5.8, 5.4, 4.4]],
  },
  bear: {
    rows: ["##...##", "#######", "#######", "#######", ".#####.", "..###.."],
    marks: [["dot", 2.3, 2.2, 0.25], ["dot", 2.3, 4.8, 0.25], ["ring", 3.7, 3.5, 1.1, 0.75], ["dot", 3.4, 3.5, 0.22]],
  },
  mouse: {
    rows: ["##.##", "#####", ".###.", "..#.."],
    marks: [["dot", 1.5, 1.6, 0.2], ["dot", 1.5, 3.4, 0.2], ["dot", 3.5, 2.5, 0.22]],
  },
  chick: {
    rows: [".##.", "####", "####", ".##."],
    marks: [["dot", 1.3, 2.6, 0.2], ["dot", 1.9, 3.7, 0.2]],
  },
  crab: {
    rows: ["#.....#", "##...##", ".#####.", "#######", ".#####.", ".#.#.#."],
    marks: [["dot", 2.5, 2.4, 0.25], ["dot", 2.5, 4.6, 0.25], ["line", 3.6, 2.8, 3.6, 4.2]],
  },
  octopus: {
    rows: ["..####..", ".######.", "########", "########", "##.##.##", "#..##..#"],
    marks: [["dot", 2.3, 2.6, 0.3], ["dot", 2.3, 5.4, 0.3], ["line", 3.4, 3.2, 3.4, 4.8]],
  },
  snowman: {
    rows: ["...##...", "..####..", "..####..", "...##...", ".######.", "########", "########", ".######."],
    marks: [["dot", 1.5, 3.4, 0.17], ["dot", 1.5, 4.6, 0.17], ["dot", 2.3, 4.0, 0.2], ["dot", 4.9, 4.0, 0.22], ["dot", 6.1, 4.0, 0.22]],
  },
  cupcake: {
    rows: ["...##...", ".######.", "########", ".######.", ".######.", "..####.."],
    marks: [["line", 3.2, 2.7, 5.8, 3.0], ["line", 3.2, 4.0, 5.8, 4.0], ["line", 3.2, 5.3, 5.8, 5.0],
      ["dot", 1.5, 2.5, 0.15], ["dot", 2.2, 5.5, 0.15], ["dot", 1.6, 4.6, 0.15]],
  },
  iceCream: {
    rows: [".###.", "#####", "#####", ".###.", ".###.", "..#..", "..#.."],
    marks: [["line", 3.0, 1.0, 3.0, 4.0], ["line", 3.2, 1.6, 6.6, 2.5], ["line", 3.2, 3.4, 6.6, 2.5], ["dot", 1.3, 2.0, 0.15], ["dot", 1.8, 3.3, 0.15]],
  },
  ufo: {
    rows: ["...###...", "..#####..", "#########", ".#######.", "..#.#.#.."],
    marks: [["dot", 2.5, 2.5, 0.25], ["dot", 2.5, 4.5, 0.25], ["dot", 2.5, 6.5, 0.25]],
  },
  dino: {
    rows: ["......###", "......###", ".....##..", "#...####.", "##.#####.", "#######..", ".#####...", ".#..#...."],
    marks: [["dot", 0.7, 7.4, 0.2], ["line", 1.6, 7.2, 1.6, 8.6]],
  },
  fox: {
    rows: ["#.....#", "##...##", "###.###", "#######", ".#####.", "..###..", "...#..."],
    marks: [["dot", 3.3, 2.2, 0.25], ["dot", 3.3, 4.8, 0.25], ["dot", 6.4, 3.5, 0.25]],
  },
  hedgehog: {
    rows: ["..#.#.#...", ".#######..", "#########.", "##########", ".########.", "..#....#.."],
    marks: [["dot", 3.4, 8.0, 0.22], ["dot", 3.6, 9.6, 0.25]],
  },
  teapot: {
    rows: ["..##....", ".#####..", "#######.", "########", "#######.", ".#####.."],
    marks: [["line", 1.0, 1.6, 1.0, 5.4]],
  },
  watermelon: {
    rows: ["##########", ".########.", "..######..", "...####..."],
    marks: [["line", 0.25, 0.3, 0.25, 9.7], ["dot", 1.0, 2.5, 0.18], ["dot", 1.0, 5.0, 0.18], ["dot", 1.0, 7.5, 0.18], ["dot", 2.0, 3.8, 0.18], ["dot", 2.0, 6.2, 0.18]],
  },
  turtle: {
    rows: ["...####...", "..######..", ".########.", "##########", "##########", ".########.", ".##....##."],
    marks: [["ring", 2.8, 5.0, 2.6, 1.6], ["line", 1.2, 5.0, 4.4, 5.0]],
  },
  pumpkin: {
    rows: ["....#.....", "....#.....", ".########.", "##########", "##########", "##########", ".########.", "..######.."],
    marks: [["dot", 3.6, 3.0, 0.4], ["dot", 3.6, 7.0, 0.4], ["dot", 4.6, 5.0, 0.25], ["line", 5.6, 2.6, 6.2, 5.0], ["line", 6.2, 5.0, 5.6, 7.4]],
  },
  astronaut: {
    rows: ["..######..", ".########.", "##########", "##########", "##########", ".########.", "..######..", "...####..."],
    marks: [["ring", 3.2, 5.0, 3.4, 1.9], ["dot", 2.2, 2.6, 0.25]],
  },
  clown: {
    rows: ["....##....", ".##.##.##.", ".########.", ".########.", ".########.", ".########.", "..######..", "...####..."],
    marks: [["dot", 0.5, 5.0, 0.25], ["line", 2.7, 2.6, 2.9, 3.8], ["line", 2.9, 6.2, 2.7, 7.4],
      ["dot", 3.5, 3.5, 0.3], ["dot", 3.5, 6.5, 0.3], ["dot", 4.7, 5.0, 0.6, "#e11d48"],
      ["ring", 5.0, 2.4, 0.4, 0.4], ["ring", 5.0, 7.6, 0.4, 0.4], ["line", 5.6, 3.0, 6.3, 5.0], ["line", 6.3, 5.0, 5.6, 7.0]],
  },
  lion: {
    rows: ["..#####..", ".#######.", "#########", "#########", "#########", "#########", "#########", ".#######.", "..#####.."],
    marks: [["ring", 4.5, 4.5, 3.4, 3.4], ["dot", 3.6, 3.2, 0.28], ["dot", 3.6, 5.8, 0.28], ["dot", 5.0, 4.5, 0.35],
      ["line", 5.4, 4.5, 6.0, 3.8], ["line", 5.4, 4.5, 6.0, 5.2]],
  },
};

function figureMask(name) {
  return rowsToMask(FIGURES[name].rows);
}

const FIRST_FIGURE_LEVEL = 4;

// Figures that belong to one particular level no matter what the matching below would pick. The
// rest are matched around them.
const PINNED_FIGURES = { 67: "clown" };
let figureByLevel = null;

// level -> figure name. Pictures must not bend the straight difficulty line, so each figure goes
// to a level whose planned area is close to its own. Figures sorted by area are matched to free
// levels in increasing order with the smallest total mismatch (a small dynamic programme over
// figures x levels); the order constraint is what keeps a bigger picture from ever landing before
// a smaller one.
function figureLevels() {
  if (figureByLevel) return figureByLevel;
  figureByLevel = new Map();
  Object.entries(PINNED_FIGURES).forEach(([lv, name]) => figureByLevel.set(Number(lv), name));
  const pinned = new Set(Object.values(PINNED_FIGURES));
  const figs = Object.keys(FIGURES)
    .filter((name) => !pinned.has(name))
    .map((name) => ({ name, area: maskArea(figureMask(name)) }))
    .sort((a, b) => a.area - b.area || (a.name < b.name ? -1 : 1));
  const levels = [];
  for (let lv = FIRST_FIGURE_LEVEL; lv <= LEVEL_COUNT; lv++) if (!ORNAMENTS[lv] && !PINNED_FIGURES[lv]) levels.push(lv);
  const F = figs.length;
  const M = levels.length;
  // cost[i][j]: best total mismatch placing figures [0, i) within levels [0, j).
  const INF = 1e9;
  const cost = [];
  const took = [];
  for (let i = 0; i <= F; i++) {
    cost.push(new Array(M + 1).fill(INF));
    took.push(new Array(M + 1).fill(false));
  }
  for (let j = 0; j <= M; j++) cost[0][j] = 0;
  for (let i = 1; i <= F; i++) {
    for (let j = i; j <= M; j++) {
      const skip = cost[i][j - 1];
      const take = cost[i - 1][j - 1] + Math.abs(targetArea(levels[j - 1]) - figs[i - 1].area);
      if (take <= skip) {
        cost[i][j] = take;
        took[i][j] = true;
      } else {
        cost[i][j] = skip;
      }
    }
  }
  for (let i = F, j = M; i > 0 && j > 0; j--) {
    if (took[i][j]) {
      figureByLevel.set(levels[j - 1], figs[i - 1].name);
      i--;
    }
  }
  return figureByLevel;
}

// Every level has a name. A figure or ornament level is called by its picture; the rest take their
// era's words in order - "e1n1" is the first such level of the first era ("Начало") - so a word
// belongs to its era however many pictures land in it. The words live in the locale files under
// games.tileFit.levelNames.<key>.
function nameKey(level) {
  const figs = figureLevels();
  if (ORNAMENTS[level]) return ORNAMENTS[level].key;
  if (figs.has(level)) return figs.get(level);
  const era = Math.floor((level - 1) / 10);
  let k = 0;
  for (let lv = era * 10 + 1; lv <= level; lv++) if (!figs.has(lv) && !ORNAMENTS[lv]) k++;
  return `e${era + 1}n${k}`;
}

function targetArea(level) {
  return 8 + Math.round(((level - 1) * 62) / (LEVEL_COUNT - 1));
}

// Piece sizes by band. The bands are what make the curve feel straight: area grows every level,
// and every so often the pieces themselves get one cell bigger.
function sizeRange(level) {
  if (level <= 10) return { min: 2, max: 4 };
  if (level <= 30) return { min: 3, max: 4 };
  if (level <= 60) return { min: 3, max: 5 };
  return { min: 4, max: 5 };
}

function buildMask(kind, w, h) {
  const fn = SHAPES[kind];
  const mask = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) row.push(fn(r, c, w, h) ? 1 : 0);
    mask.push(row);
  }
  return trimMask(mask);
}

function trimMask(mask) {
  let top = 0;
  while (top < mask.length && !mask[top].some(Boolean)) top++;
  let bottom = mask.length - 1;
  while (bottom >= top && !mask[bottom].some(Boolean)) bottom--;
  if (top > bottom) return [];
  const rows = mask.slice(top, bottom + 1);
  let left = 0;
  while (rows.every((row) => !row[left])) left++;
  let right = rows[0].length - 1;
  while (rows.every((row) => !row[right])) right--;
  return rows.map((row) => row.slice(left, right + 1));
}

function maskArea(mask) {
  let n = 0;
  mask.forEach((row) => row.forEach((v) => (n += v)));
  return n;
}

function isConnected(mask) {
  const h = mask.length;
  const w = h ? mask[0].length : 0;
  let start = null;
  for (let r = 0; r < h && !start; r++) for (let c = 0; c < w; c++) if (mask[r][c]) { start = [r, c]; break; }
  if (!start) return false;
  const seen = mask.map((row) => row.map(() => false));
  const stack = [start];
  seen[start[0]][start[1]] = true;
  let count = 0;
  while (stack.length) {
    const [r, c] = stack.pop();
    count++;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < h && nc >= 0 && nc < w && mask[nr][nc] && !seen[nr][nc]) {
        seen[nr][nc] = true;
        stack.push([nr, nc]);
      }
    }
  }
  return count === maskArea(mask);
}

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// The board of a level: the shape's own width/height pair whose area lands closest to the
// target, among boards no more than MAX_SIDE on a side and not too stretched.
function pickBoard(level) {
  if (ORNAMENTS[level]) return { mask: rowsToMask(ORNAMENTS[level].rows), kind: ORNAMENTS[level].key, ornament: true };
  const figure = figureLevels().get(level);
  if (figure) return { mask: figureMask(figure), kind: figure, figure: true };
  const kind = shapeFor(level);
  const target = targetArea(level);
  let best = null;
  for (let h = 2; h <= MAX_SIDE; h++) {
    for (let w = 2; w <= MAX_SIDE; w++) {
      if (Math.abs(w - h) > 4) continue;
      if (kind !== "rect" && (w < 4 || h < 4)) continue;
      const mask = buildMask(kind, w, h);
      if (!mask.length) continue;
      const area = maskArea(mask);
      if (!isConnected(mask)) continue;
      // Ties go to the squarer board, then to the wider one (the page has more width than height).
      const score = Math.abs(area - target) * 100 + Math.abs(w - h) * 2 + (h > w ? 1 : 0);
      if (!best || score < best.score) best = { score, mask, kind };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pieces.
// ---------------------------------------------------------------------------

function normalize(cells) {
  let minR = Infinity;
  let minC = Infinity;
  cells.forEach(([r, c]) => {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  });
  return cells
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// Clockwise quarter turns. A piece's rotation is always counted from the shape the generator cut,
// so a placement is fully described by (rotation, row, col) of the rotated shape's top-left.
function rotate(cells, turns) {
  let out = cells.map(([r, c]) => [r, c]);
  const k = ((turns % 4) + 4) % 4;
  for (let i = 0; i < k; i++) out = out.map(([r, c]) => [c, -r]);
  return normalize(out);
}

function shapeKey(cells) {
  return normalize(cells).map(([r, c]) => `${r}.${c}`).join(",");
}

// Same piece up to rotation (mirroring is not a move in this game, so an S and a Z are different).
function canonicalKey(cells) {
  let best = null;
  for (let t = 0; t < 4; t++) {
    const key = shapeKey(rotate(cells, t));
    if (best === null || key < best) best = key;
  }
  return best;
}

function isStraight(cells) {
  return cells.every(([r]) => r === cells[0][0]) || cells.every(([, c]) => c === cells[0][1]);
}

// Which region sizes can be cut entirely into pieces of the allowed sizes.
function fillableSizes(range, limit) {
  const ok = new Array(limit + 1).fill(false);
  ok[0] = true;
  for (let n = 1; n <= limit; n++) {
    for (let s = range.min; s <= range.max && !ok[n]; s++) if (n >= s && ok[n - s]) ok[n] = true;
  }
  return ok;
}

function remainingComponentsOk(owner, mask, fillable) {
  const h = mask.length;
  const w = mask[0].length;
  const seen = owner.map((row) => row.map(() => false));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!mask[r][c] || owner[r][c] !== -1 || seen[r][c]) continue;
      let size = 0;
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        size++;
        for (const [dr, dc] of DIRS) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr >= 0 && nr < h && nc >= 0 && nc < w && mask[nr][nc] && owner[nr][nc] === -1 && !seen[nr][nc]) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
      if (!fillable[size]) return false;
    }
  }
  return true;
}

function freeNeighbours(owner, mask, r, c) {
  let n = 0;
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < mask.length && nc >= 0 && nc < mask[0].length && mask[nr][nc] && owner[nr][nc] === -1) n++;
  }
  return n;
}

// One attempt at cutting the board. Pieces grow from the most cornered free cell, so the
// awkward spots are claimed first instead of being left as unfillable holes at the end.
function tryPartition(mask, range, fillable, rng) {
  const h = mask.length;
  const w = mask[0].length;
  const owner = mask.map((row) => row.map(() => -1));
  const pieces = [];
  for (;;) {
    let start = null;
    let startFree = 9;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (!mask[r][c] || owner[r][c] !== -1) continue;
        const f = freeNeighbours(owner, mask, r, c);
        if (f < startFree) {
          startFree = f;
          start = [r, c];
        }
      }
    }
    if (!start) return pieces;

    let placed = false;
    for (let attempt = 0; attempt < 8 && !placed; attempt++) {
      // Larger pieces are drawn more often: the top size of a band is what the band is about.
      const span = range.max - range.min + 1;
      const target = range.min + Math.min(span - 1, randInt(rng, span + 1));
      const cells = [start];
      owner[start[0]][start[1]] = pieces.length;
      while (cells.length < target) {
        const frontier = [];
        cells.forEach(([r, c]) => {
          for (const [dr, dc] of DIRS) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < h && nc >= 0 && nc < w && mask[nr][nc] && owner[nr][nc] === -1 &&
                !frontier.some(([fr, fc]) => fr === nr && fc === nc)) {
              frontier.push([nr, nc]);
            }
          }
        });
        if (!frontier.length) break;
        const next = frontier[randInt(rng, frontier.length)];
        owner[next[0]][next[1]] = pieces.length;
        cells.push(next);
      }
      if (cells.length >= range.min && remainingComponentsOk(owner, mask, fillable)) {
        pieces.push(cells);
        placed = true;
      } else {
        cells.forEach(([r, c]) => (owner[r][c] = -1));
      }
    }
    if (!placed) return null;
  }
}

// Repeats among the pieces and straight bars are what make a packing puzzle easy, so of several
// valid cuts the one with the fewest of both is kept.
function partitionPenalty(pieces) {
  const counts = new Map();
  let penalty = 0;
  pieces.forEach((cells) => {
    const key = canonicalKey(cells);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (isStraight(cells) && cells.length > 2) penalty += 2;
  });
  counts.forEach((n) => (penalty += (n - 1) * 3));
  return penalty;
}

const CANDIDATES = 14;
const MAX_ATTEMPTS = 400;

const cache = new Map();

function generateLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n > LEVEL_COUNT) return null;
  if (cache.has(n)) return cache.get(n);

  const rng = mulberry32((SALT ^ Math.imul(n, 0x9e3779b1)) >>> 0);
  const board = pickBoard(n);
  const mask = board.mask;
  const range = sizeRange(n);
  const fillable = fillableSizes(range, maskArea(mask));

  let best = null;
  let found = 0;
  for (let i = 0; i < MAX_ATTEMPTS && found < CANDIDATES; i++) {
    const pieces = tryPartition(mask, range, fillable, rng);
    if (!pieces) continue;
    found++;
    const penalty = partitionPenalty(pieces);
    if (!best || penalty < best.penalty) best = { pieces, penalty };
  }
  if (!best) throw new Error(`tile-fit: level ${n} could not be generated`);

  const cut = best.pieces.map((cells) => ({ cells: normalize(cells) }));

  // The tray shows pieces in a shuffled order and a random turn, so the cut is not readable off
  // the tray's layout.
  const order = cut.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pieces = order.map((i) => ({ cells: cut[i].cells, startRotation: randInt(rng, 4) }));

  const result = {
    level: n,
    version: LEVELS_VERSION,
    shape: board.kind,
    name: nameKey(n),
    marks: board.figure ? FIGURES[board.kind].marks : [],
    rows: mask.length,
    cols: mask[0].length,
    mask,
    area: maskArea(mask),
    pieces,
    ornament: !!board.ornament,
  };
  cache.set(n, result);
  return result;
}

// A solution is one placement per piece, in the level's piece order: {rot, r, c}, where (r, c) is
// the board cell under the top-left of the piece's bounding box after `rot` clockwise turns.
// Returns null when it covers the board exactly, or a short reason string otherwise.
function checkSolution(levelData, placements) {
  if (!levelData) return "level";
  if (!Array.isArray(placements) || placements.length !== levelData.pieces.length) return "count";
  const { rows, cols, mask } = levelData;
  const taken = mask.map((row) => row.map(() => false));
  let covered = 0;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (!p || !Number.isInteger(p.rot) || !Number.isInteger(p.r) || !Number.isInteger(p.c)) return "shape";
    const cells = rotate(levelData.pieces[i].cells, p.rot);
    for (const [dr, dc] of cells) {
      const r = p.r + dr;
      const c = p.c + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols || !mask[r][c]) return "outside";
      if (taken[r][c]) return "overlap";
      taken[r][c] = true;
      covered++;
    }
  }
  return covered === levelData.area ? null : "gaps";
}

const api = {
  LEVEL_COUNT,
  LEVELS_VERSION,
  generateLevel,
  checkSolution,
  rotate,
  normalize,
  canonicalKey,
  targetArea,
  sizeRange,
  shapeFor,
  nameKey,
  ORNAMENTS,
  figureLevels,
  FIGURE_NAMES: Object.keys(FIGURES),
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
} else {
  window.TileFitEngine = api;
}
