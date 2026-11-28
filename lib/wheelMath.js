// The movie wheel's arithmetic (views/mediaWheel.ejs, public/js/media-wheel.js). One file for the
// server's tests and for the browser: lib/sharedScripts.js serves it at /js/shared/wheel-math.js,
// and it assigns module.exports under Node and window.WheelMath in a plain <script>.
//
// Two wheels, one outcome. The plain wheel picks option i with probability w_i / W (W = the sum of
// the weights of the options still on it). The elimination wheel throws one option OFF per spin
// until one is left, and that last one must win with the same w_i / W - otherwise the two modes
// would be two different lotteries under one set of weights.
//
// The naive elimination wheel (sector = w_j, the option landed on drops out) does not do that: with
// weights 2 and 1 the heavier option is eliminated first two times out of three, so it wins only
// 1/3 instead of 2/3. Heavy options are punished for being heavy.
//
// The sector that does it: on a wheel of n >= 2 options with total W, option j is eliminated with
//
//     p_j = (W - w_j) / ((n - 1) * W)
//
// i.e. its sector is proportional to the weight of everybody ELSE. These are probabilities
// (each >= 0, and they sum to (nW - W) / ((n - 1)W) = 1). Claim: the last option left is i with
// probability w_i / W. By induction on n. For n = 1 it is the only option. For n > 1, after one
// spin the wheel is the same game on n - 1 options without j, whose total is W - w_j, so by the
// hypothesis i is last with probability w_i / (W - w_j) for every j != i:
//
//     P(i last) = sum_{j != i} p_j * w_i / (W - w_j)
//               = sum_{j != i} (W - w_j) / ((n - 1) W) * w_i / (W - w_j)
//               = (n - 1) * w_i / ((n - 1) W) = w_i / W.
//
// (A step where W - w_j = 0 has p_j = 0 and is never taken.) The formula is also the only one
// that works for every set of weights: requiring P(i last) = w_i / W on every sub-wheel gives
// sum_{j != i} p_j / (W - w_j) = 1 / W for every i, so all p_j / (W - w_j) are equal. With equal
// weights it is the familiar wheel: every sector the same size.
//
// Options of weight 0 cannot win either wheel and are taken off before it is drawn.
(function (root) {
  "use strict";

  function cleanWeights(weights) {
    return weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  }

  // The sector sizes of the plain wheel: the weights themselves.
  function plainSectors(weights) {
    return cleanWeights(weights);
  }

  // The sector sizes of the elimination wheel, in the same units as the weights (they sum to
  // (n - 1) * W). One option left: it is the winner, its "sector" is the whole wheel.
  function eliminationSectors(weights) {
    const w = cleanWeights(weights);
    if (w.length <= 1) return w.map(() => 1);
    const total = w.reduce((a, b) => a + b, 0);
    return w.map((x) => total - x);
  }

  function sectorsFor(mode, weights) {
    return mode === "elimination" ? eliminationSectors(weights) : plainSectors(weights);
  }

  // The index a uniform u in [0, 1) lands on, sectors laid out in order. -1 when nothing has size.
  function pickIndex(sectors, u) {
    const total = sectors.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    if (!(total > 0)) return -1;
    let at = u * total;
    let last = -1;
    for (let i = 0; i < sectors.length; i++) {
      if (!(sectors[i] > 0)) continue;
      last = i;
      if (at < sectors[i]) return i;
      at -= sectors[i];
    }
    return last; // u * total rounding up to total
  }

  // Where sector i sits on the wheel, as fractions of a turn: {start, end}.
  function sectorSpan(sectors, i) {
    const total = sectors.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    let start = 0;
    for (let k = 0; k < i; k++) start += sectors[k] > 0 ? sectors[k] : 0;
    const size = sectors[i] > 0 ? sectors[i] : 0;
    return { start: start / total, end: (start + size) / total };
  }

  // A whole elimination game without the drawing: indices in the order they drop out, then the
  // winner. `rand` returns uniforms in [0, 1).
  function runElimination(weights, rand) {
    let alive = cleanWeights(weights).map((w, i) => ({ w, i })).filter((o) => o.w > 0);
    const out = [];
    while (alive.length > 1) {
      const k = pickIndex(eliminationSectors(alive.map((o) => o.w)), rand());
      out.push(alive[k].i);
      alive = alive.filter((_, j) => j !== k);
    }
    return { eliminated: out, winner: alive.length ? alive[0].i : -1 };
  }

  // The plain wheel's chances, for the list beside the wheel: w_i / W. The elimination wheel's
  // winning chances are the same numbers - that is the point of it.
  function winChances(weights) {
    const w = cleanWeights(weights);
    const total = w.reduce((a, b) => a + b, 0);
    return w.map((x) => (total > 0 ? x / total : 0));
  }

  const api = { plainSectors, eliminationSectors, sectorsFor, pickIndex, sectorSpan, runElimination, winChances };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WheelMath = api;
})(typeof window !== "undefined" ? window : globalThis);
