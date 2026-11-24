// The forces behind the admin's music graph (public/js/admin-music-graph.js): every song pushes every
// other away, an edge pulls its two ends to a given distance, and a weak pull to the centre keeps the
// pieces together. It runs as a Web Worker, so a whole graph of thousands of songs settles without the
// page stuttering; without Worker (and in tests) the same class is used directly.
//
// Positions are exchanged as Float32Arrays by node index. `gen` numbers the graphs: a tick of an older
// one still on its way is recognised and dropped.
(function (scope) {
  "use strict";

  const ALPHA_MIN = 0.002;
  const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 320);
  // How lively the graph stays while a node is held.
  const DRAG_ALPHA = 0.3;
  const VELOCITY_KEEP = 0.6;
  // Barnes-Hut: a cell this small against its distance counts as one body.
  const THETA2 = 0.81;
  const DISTANCE_MIN2 = 30;
  const SPEED_MAX = 160;
  const DEPTH_MAX = 32;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  const DEFAULTS = { center: 0.06, repel: 220, link: 1, distance: 70 };

  class Simulation {
    constructor(forces) {
      this.forces = { ...DEFAULTS, ...forces };
      this.n = 0;
      this.alpha = 0;
      this.held = -1;
    }

    // x, y: where the nodes are now, NaN for a new one. links: [from, to, from, to, ...] by index.
    setGraph({ x, y, links }, alpha = 1) {
      const n = x.length;
      this.n = n;
      this.x = Float64Array.from(x);
      this.y = Float64Array.from(y);
      this.vx = new Float64Array(n);
      this.vy = new Float64Array(n);
      this.links = links;
      this.degree = new Float64Array(n);
      for (let i = 0; i < links.length; i++) this.degree[links[i]]++;
      this.held = -1;
      this.alpha = alpha;
      this.place();
      this.next = new Int32Array(n);
      this.stack = new Int32Array(1024);
      this.cells(Math.max(64, n * 2));
    }

    // A new node starts beside a neighbour that already has a place, so what is added to a graph on
    // screen grows out of it; with none it goes on a sunflower spiral, which no two nodes share.
    place() {
      const { x, y, links, n } = this;
      const open = (i) => Number.isNaN(x[i]);
      for (let round = 0; round < 3; round++) {
        let left = false;
        for (let k = 0; k < links.length; k += 2) {
          for (const [at, from] of [[links[k], links[k + 1]], [links[k + 1], links[k]]]) {
            if (!open(at)) continue;
            if (open(from)) {
              left = true;
              continue;
            }
            const angle = at * GOLDEN;
            x[at] = x[from] + Math.cos(angle) * 18;
            y[at] = y[from] + Math.sin(angle) * 18;
          }
        }
        if (!left) break;
      }
      for (let i = 0; i < n; i++) {
        if (!open(i)) continue;
        const r = 14 * Math.sqrt(0.5 + i);
        x[i] = r * Math.cos(i * GOLDEN);
        y[i] = r * Math.sin(i * GOLDEN);
      }
    }

    hold(i, x, y) {
      if (i < 0 || i >= this.n) return;
      this.held = i;
      this.hx = x;
      this.hy = y;
      this.alpha = Math.max(this.alpha, DRAG_ALPHA);
    }

    release() {
      this.held = -1;
    }

    reheat(alpha) {
      this.alpha = Math.max(this.alpha, alpha);
    }

    get moving() {
      return this.n > 0 && (this.alpha >= ALPHA_MIN || this.held >= 0);
    }

    tick() {
      const { n, x, y, vx, vy, links, degree, forces } = this;
      this.alpha += ((this.held >= 0 ? DRAG_ALPHA : 0) - this.alpha) * ALPHA_DECAY;
      const alpha = this.alpha;

      for (let k = 0; k < links.length; k += 2) {
        const s = links[k];
        const t = links[k + 1];
        let dx = x[t] + vx[t] - x[s] - vx[s] || 1e-3;
        let dy = y[t] + vy[t] - y[s] - vy[s] || 1e-3;
        const d = Math.sqrt(dx * dx + dy * dy);
        // A song many edges meet in must not be torn apart by them: an edge is as strong as its less
        // connected end is free.
        const pull = (((d - forces.distance) / d) * alpha * forces.link) / Math.min(degree[s], degree[t]);
        dx *= pull;
        dy *= pull;
        const share = degree[s] / (degree[s] + degree[t]);
        vx[t] -= dx * share;
        vy[t] -= dy * share;
        vx[s] += dx * (1 - share);
        vy[s] += dy * (1 - share);
      }

      this.push(alpha);

      const toCenter = forces.center * alpha;
      for (let i = 0; i < n; i++) {
        vx[i] = (vx[i] - x[i] * toCenter) * VELOCITY_KEEP;
        vy[i] = (vy[i] - y[i] * toCenter) * VELOCITY_KEEP;
        const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (speed > SPEED_MAX) {
          vx[i] *= SPEED_MAX / speed;
          vy[i] *= SPEED_MAX / speed;
        }
        x[i] += vx[i];
        y[i] += vy[i];
      }
      if (this.held >= 0) {
        x[this.held] = this.hx;
        y[this.held] = this.hy;
        vx[this.held] = vy[this.held] = 0;
      }
    }

    // --- the push: a quadtree over the nodes, rebuilt every tick -------------------------------------

    cells(size) {
      this.child = new Int32Array(size * 4); // 0 nothing, c + 1 a cell, -(i + 1) a node
      this.mass = new Float64Array(size);
      this.mx = new Float64Array(size);
      this.my = new Float64Array(size);
      this.half = new Float64Array(size);
      this.capacity = size;
    }

    newCell(half) {
      if (this.used === this.capacity) {
        const { child, half: halves } = this;
        this.cells(this.capacity * 2);
        this.child.set(child);
        this.half.set(halves);
      }
      const c = this.used++;
      this.child.fill(0, c * 4, c * 4 + 4);
      this.half[c] = half;
      return c;
    }

    build() {
      const { n, x, y, next } = this;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        if (x[i] < x0) x0 = x[i];
        if (x[i] > x1) x1 = x[i];
        if (y[i] < y0) y0 = y[i];
        if (y[i] > y1) y1 = y[i];
      }
      const half0 = Math.max(x1 - x0, y1 - y0, 1) / 2 + 1;
      const cx0 = (x0 + x1) / 2;
      const cy0 = (y0 + y1) / 2;
      this.used = 0;
      this.newCell(half0);
      next.fill(-1);
      for (let i = 0; i < n; i++) {
        let c = 0, cx = cx0, cy = cy0, half = half0, depth = 0;
        for (;;) {
          const q = (x[i] > cx ? 1 : 0) + (y[i] > cy ? 2 : 0);
          const at = this.child[c * 4 + q];
          if (at === 0) {
            this.child[c * 4 + q] = -(i + 1);
            break;
          }
          if (at < 0 && depth >= DEPTH_MAX) {
            // As good as the same point: they share a leaf.
            next[i] = -at - 1;
            this.child[c * 4 + q] = -(i + 1);
            break;
          }
          half /= 2;
          cx += q & 1 ? half : -half;
          cy += q & 2 ? half : -half;
          depth++;
          if (at > 0) {
            c = at - 1;
            continue;
          }
          const other = -at - 1;
          const cell = this.newCell(half);
          this.child[c * 4 + q] = cell + 1;
          this.child[cell * 4 + (x[other] > cx ? 1 : 0) + (y[other] > cy ? 2 : 0)] = at;
          c = cell;
        }
      }
      // A cell is always made after its parent, so backwards is children first.
      for (let c = this.used - 1; c >= 0; c--) {
        let mass = 0, mx = 0, my = 0;
        for (let q = 0; q < 4; q++) {
          const at = this.child[c * 4 + q];
          if (at > 0) {
            mass += this.mass[at - 1];
            mx += this.mx[at - 1] * this.mass[at - 1];
            my += this.my[at - 1] * this.mass[at - 1];
          } else if (at < 0) {
            for (let i = -at - 1; i >= 0; i = next[i]) {
              mass++;
              mx += x[i];
              my += y[i];
            }
          }
        }
        this.mass[c] = mass;
        this.mx[c] = mx / mass;
        this.my[c] = my / mass;
      }
    }

    push(alpha) {
      const { n, x, y, vx, vy, next } = this;
      if (n < 2) return;
      this.build();
      const { child, mass, mx, my, half } = this;
      const force = this.forces.repel * alpha;
      if (this.stack.length < this.used + 4) this.stack = new Int32Array(this.used * 2 + 4);
      const { stack } = this;
      for (let i = 0; i < n; i++) {
        let top = 0;
        stack[top++] = 0;
        while (top > 0) {
          const c = stack[--top];
          const dx = x[i] - mx[c];
          const dy = y[i] - my[c];
          const d2 = dx * dx + dy * dy;
          const width = half[c] * 2;
          if (width * width < THETA2 * d2) {
            const f = (force * mass[c]) / Math.max(d2, DISTANCE_MIN2);
            vx[i] += dx * f;
            vy[i] += dy * f;
            continue;
          }
          for (let q = 0; q < 4; q++) {
            const at = child[c * 4 + q];
            if (at > 0) stack[top++] = at - 1;
            else if (at < 0) {
              for (let j = -at - 1; j >= 0; j = next[j]) {
                if (j === i) continue;
                // Two nodes on one point are pushed apart whichever way their numbers say.
                const ex = x[i] - x[j] || (i - j) * 1e-3;
                const ey = y[i] - y[j] || (i - j) * 1e-3;
                const f = force / Math.max(ex * ex + ey * ey, DISTANCE_MIN2);
                vx[i] += ex * f;
                vy[i] += ey * f;
              }
            }
          }
        }
      }
    }
  }

  // --- what the page talks to ------------------------------------------------------------------------

  // send(message, transfer). Returns the function that takes the page's messages:
  //   graph    { gen, x, y, links, alpha, settle }   settle: run this many ticks before showing anything
  //   forces   { forces, alpha }
  //   hold     { i, x, y } / release
  // and sends { gen, xy, moving } - xy is x0, y0, x1, y1, ...
  function serve(send) {
    const sim = new Simulation();
    const STEP_MS = 15;
    let gen = 0;
    let timer = null;

    function post() {
      const xy = new Float32Array(sim.n * 2);
      for (let i = 0; i < sim.n; i++) {
        xy[i * 2] = sim.x[i];
        xy[i * 2 + 1] = sim.y[i];
      }
      send({ gen, xy, moving: sim.moving }, [xy.buffer]);
    }
    function step() {
      timer = null;
      const started = Date.now();
      sim.tick();
      post();
      if (sim.moving) timer = setTimeout(step, Math.max(0, STEP_MS - (Date.now() - started)));
    }
    function run() {
      if (timer === null && sim.moving) timer = setTimeout(step, 0);
    }

    return (m) => {
      if (m.type === "graph") {
        gen = m.gen;
        sim.setGraph(m, m.alpha);
        for (let i = 0; i < (m.settle || 0) && sim.moving; i++) sim.tick();
        post();
      } else if (m.type === "forces") {
        Object.assign(sim.forces, m.forces);
        if (m.alpha) sim.reheat(m.alpha);
      } else if (m.type === "hold") sim.hold(m.i, m.x, m.y);
      else if (m.type === "release") sim.release();
      run();
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { Simulation, DEFAULTS, serve };
  else if (typeof scope.document === "undefined" && typeof scope.postMessage === "function") {
    const take = serve((message, transfer) => scope.postMessage(message, transfer));
    scope.onmessage = (event) => take(event.data);
  } else scope.musicGraphSim = { serve, DEFAULTS };
})(typeof self !== "undefined" ? self : globalThis);
