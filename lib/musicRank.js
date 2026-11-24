// The learnt weights: a logistic regression over the journal (lib/musicJournal.js) that says how likely a
// track is to be skipped. Pure. It only tilts what the walk offers, within FACTOR_MIN..FACTOR_MAX, and
// everything that keeps the music from going in circles stands outside it.
//
// Nothing is learnt until there is enough to learn from (ROWS_MIN, SKIPS_MIN): on less it would learn the
// noise. And a model is used only when, on the last week - which it has not seen - it tells the skipped
// from the heard better than the formula that chose them does (AUC_MARGIN), and by more than a week that
// size would by luck: it is trained every day, and luck gets that many tries.
const { SKIPS } = require("./musicJournal");

const DAY_MS = 24 * 60 * 60 * 1000;
const ROWS_MIN = 1500;
const SKIPS_MIN = 150;
const TEST_DAYS = 7;
const TEST_ROWS_MIN = 150;
const TEST_SKIPS_MIN = 20;
const AUC_MARGIN = 0.03;
const LUCK_OVER_HALF = 3; // standard errors
const LUCK_OVER_FORMULA = 1.5;
const L2 = 2;
const ROUNDS = 400;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.5;

const log = (v) => Math.log(Math.max(v || 0, 1e-6));

// name -> (why, context) => number. context: { hour, category, viewers } of the moment. A number that is not
// there is null and reads as the average.
const FEATURES = {
  reach: (w) => w.reach,
  walk: (w) => log(w.p),
  fresh: (w) => w.fresh,
  song: (w) => w.score,
  edge: (w) => w.edge,
  unheard: (w) => (w.unheard ? 1 : 0),
  genre: (w) => w.sim,
  energy: (w) => w.energy,
  sameArtist: (w) => (w.sameArtist ? 1 : 0),
  moodAsked: (w) => (w.mode && w.mode.mood !== "any" ? 1 : 0),
  newAsked: (w) => (w.mode ? { known: -1, even: 0, new: 1 }[w.mode.novelty] || 0 : 0),
  hour: (_, c) => (Number.isFinite(c.hour) ? Math.min(8, c.hour) : null),
};
const NAMES = Object.keys(FEATURES);
const num = (v) => (Number.isFinite(v) ? v : null);

function raw(why, context = {}) {
  return NAMES.map((name) => num(FEATURES[name](why, context)));
}

// A row to learn from, or null. Only what the graph chose and somebody could have skipped.
function example(event) {
  if (!event.why || !Number.isFinite(event.why.p) || event.live === false) return null;
  const skipped = SKIPS.has(event.outcome) || event.outcome === "dropped";
  if (!skipped && event.outcome !== "listened" && event.outcome !== "skipLate") return null;
  return { x: raw(event.why, event), y: skipped ? 1 : 0, at: new Date(event.endedAt).getTime(), base: -log(event.why.chance) };
}

function scale(x, { mean, sd }) {
  return x.map((v, i) => (v === null ? 0 : (v - mean[i]) / sd[i]));
}
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function fit(rows) {
  const k = NAMES.length;
  const mean = new Array(k).fill(0);
  const sd = new Array(k).fill(1);
  for (let i = 0; i < k; i++) {
    const values = rows.map((r) => r.x[i]).filter((v) => v !== null);
    if (values.length === 0) continue;
    mean[i] = values.reduce((a, b) => a + b, 0) / values.length;
    sd[i] = Math.sqrt(values.reduce((a, v) => a + (v - mean[i]) ** 2, 0) / values.length) || 1;
  }
  const xs = rows.map((r) => scale(r.x, { mean, sd }));
  const rate = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  let bias = Math.log(rate / (1 - rate));
  let w = new Array(k).fill(0);
  // Plain gradient descent on scaled features; a step that does not help is halved.
  let step = 1;
  const loss = (b, v) => rows.reduce((sum, r, n) => {
    const z = b + xs[n].reduce((a, x, i) => a + x * v[i], 0);
    return sum + Math.log(1 + Math.exp(-Math.abs(z))) + (z > 0 ? (r.y ? 0 : z) : r.y ? -z : 0);
  }, 0) / rows.length + (L2 / (2 * rows.length)) * v.reduce((a, x) => a + x * x, 0);
  let current = loss(bias, w);
  for (let round = 0; round < ROUNDS && step > 1e-4; round++) {
    let gb = 0;
    const g = new Array(k).fill(0);
    rows.forEach((r, n) => {
      const e = sigmoid(bias + xs[n].reduce((a, x, i) => a + x * w[i], 0)) - r.y;
      gb += e;
      for (let i = 0; i < k; i++) g[i] += e * xs[n][i];
    });
    const b2 = bias - (step * gb) / rows.length;
    const w2 = w.map((v, i) => v - step * (g[i] / rows.length + (L2 / rows.length) * v));
    const next = loss(b2, w2);
    if (next > current) {
      step /= 2;
      continue;
    }
    if (current - next < 1e-9) break;
    bias = b2;
    w = w2;
    current = next;
  }
  return { bias, weights: w, mean, sd };
}

// How often a skipped one is rated above a heard one.
function auc(rows, rate) {
  const sorted = rows.map((r) => ({ y: r.y, v: rate(r) })).sort((a, b) => a.v - b.v);
  let rank = 0;
  let sum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
    const average = (i + 1 + j) / 2;
    for (; i < j; i++) if (sorted[i].y) sum += average;
    rank = j;
  }
  const pos = sorted.filter((s) => s.y).length;
  const neg = rank - pos;
  return pos > 0 && neg > 0 ? (sum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

// The standard error of an auc of one half (Hanley and McNeil).
function aucError(pos, neg) {
  return Math.sqrt((0.25 + ((pos - 1) + (neg - 1)) * (1 / 3 - 0.25)) / (pos * neg));
}

const zOf = (model, x) => model.bias + scale(x, model).reduce((a, v, i) => a + v * model.weights[i], 0);

// Returns { status, rows, skips, ... }: "few" (nothing learnt), "worse" (learnt, not to be used) or "ready".
function train(events, { now = Date.now() } = {}) {
  const rows = events.map(example).filter(Boolean);
  const skips = rows.reduce((a, r) => a + r.y, 0);
  const about = { rows: rows.length, skips, rowsMin: ROWS_MIN, skipsMin: SKIPS_MIN, names: NAMES };
  if (rows.length < ROWS_MIN || skips < SKIPS_MIN) return { status: "few", ...about };
  const since = now - TEST_DAYS * DAY_MS;
  const past = rows.filter((r) => r.at < since);
  const week = rows.filter((r) => r.at >= since);
  const weekSkips = week.reduce((a, r) => a + r.y, 0);
  const pastSkips = past.reduce((a, r) => a + r.y, 0);
  if (week.length < TEST_ROWS_MIN || weekSkips < TEST_SKIPS_MIN || weekSkips === week.length || pastSkips < SKIPS_MIN / 2 || pastSkips === past.length) return { status: "few", ...about };
  const model = fit(past);
  const learnt = auc(week, (r) => zOf(model, r.x));
  const formula = auc(week, (r) => r.base);
  const error = aucError(weekSkips, week.length - weekSkips);
  const ready = learnt >= 0.5 + LUCK_OVER_HALF * error && learnt >= formula + Math.max(AUC_MARGIN, LUCK_OVER_FORMULA * error);
  return { status: ready ? "ready" : "worse", ...about, auc: learnt, formulaAuc: formula, testRows: week.length, testSkips: weekSkips, rate: skips / rows.length, ...model };
}

// What a track's chance is multiplied by: how much less (or more) likely it is to be skipped than the
// average one.
function factorOf(model, why, context) {
  const p = predict(model, why, context);
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, (1 - p) / (1 - model.rate)));
}

function predict(model, why, context) {
  return sigmoid(zOf(model, raw(why, context)));
}

const usable = (model) => Boolean(model && model.status === "ready" && Array.isArray(model.weights) && model.names && model.names.join() === NAMES.join());

module.exports = { train, predict, factorOf, usable, example, auc, NAMES, ROWS_MIN, SKIPS_MIN };
