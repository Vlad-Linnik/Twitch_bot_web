// Shared spiral cloud layout - used by statistics-chat.js (channel word + emote-image clouds)
// and user-dashboard.js (per-user word + emote clouds). Load it with a <script defer> BEFORE
// the page script that calls it.
//
// The old clouds were a flex-wrapped list sorted by count - visually a text document, not a
// cloud. This lays items out the way word clouds are expected to look: the most frequent item
// sits in the middle, and each next one walks an Archimedean spiral outward from the center
// until it finds a free spot, so frequency maps to distance-from-center as well as to size.
//
// Vanilla on purpose (no d3-cloud or similar) - same "no charting library" rule as the rest of
// the site's stats pages. Rect-vs-rect collision over <=200 items is comfortably fast.
(function () {
  "use strict";

  const PAD = 16; // inner margin - replaces the container's old p-6/p-4 (absolute children ignore padding)
  const GAP = 3; // breathing room added around every item's collision rect
  const ASPECT = 0.58; // vertical squash of the spiral - clouds read better wide than round
  const IMAGE_WAIT_MS = 3000; // don't hold the layout hostage to one slow emote CDN fetch

  // Nodes with a live layout, re-flowed when the viewport width changes.
  const registry = new Set();

  function intersects(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  // Position node's prepared elements. Runs in [0, width] x (-inf, +inf) coordinates centered
  // on x, then shifts everything down so the topmost rect lands at PAD. Separate from render()
  // so a window resize can re-place the same elements without rebuilding them.
  function place(node) {
    const state = node.__cloud;
    if (!state) return;

    const width = Math.max(node.clientWidth - PAD * 2, 240);
    const cx = width / 2;
    const placed = [];
    // Past this the spiral is just burning CPU on a saturated container.
    const maxRadius = width * 1.5;

    for (const el of state.els) {
      el.style.display = "";
      el.__rect = null;

      const w = el.offsetWidth + GAP * 2;
      const h = el.offsetHeight + GAP * 2;

      let angle = 0;
      while (!el.__rect) {
        const radius = angle * 1.6; // ~10px of radius per full turn - tight packing
        if (radius > maxRadius) break;

        const x = cx + radius * Math.cos(angle) - w / 2;
        const y = radius * ASPECT * Math.sin(angle) - h / 2;
        // Horizontal bounds are hard (the container can't grow sideways); vertical is free.
        if (x >= 0 && x + w <= width) {
          const rect = { x, y, w, h };
          if (!placed.some((p) => intersects(p, rect))) {
            el.__rect = rect;
            placed.push(rect);
          }
        }
        angle += 4 / Math.max(radius, 4); // ~4px arc steps so packing stays dense as the spiral widens
      }

      // Couldn't fit - drop it. Items arrive biggest-first, so what's dropped is the rarest tail.
      if (!el.__rect) el.style.display = "none";
    }
    if (placed.length === 0) return;

    const minY = Math.min(...placed.map((r) => r.y));
    const maxY = Math.max(...placed.map((r) => r.y + r.h));
    const contentH = Math.ceil(maxY - minY) + PAD * 2;

    // The container's min-h-* class stays the floor; a full cloud grows past it. Set the height
    // FIRST, then read back what the container actually got - if min-h won, split the surplus
    // so a sparse cloud sits vertically centered instead of hugging the top edge.
    node.style.height = `${contentH}px`;
    const surplus = Math.max(0, Math.floor((node.clientHeight - contentH) / 2));

    for (const el of state.els) {
      const r = el.__rect;
      if (!r) continue;
      el.style.left = `${Math.round(r.x + GAP + PAD)}px`;
      el.style.top = `${Math.round(r.y - minY + GAP + PAD) + surplus}px`;
      el.style.visibility = "";
    }
  }

  // items need a numeric `count`; makeEl(item) returns a detached element (span/img) already
  // sized and titled by the caller - this module only decides WHERE things go, never what they
  // look like. Async because emote images must finish loading before their width is knowable.
  async function render(node, items, makeEl) {
    if (!node) return;
    registry.add(node);

    // Anything a previous render might have left behind.
    node.textContent = "";
    node.__cloud = null;
    node.style.height = "";
    const token = (node.__cloudToken = {});

    const list = items || [];
    if (list.length === 0) return;

    // Biggest first - the spiral hands the earliest items the innermost spots.
    const els = [...list]
      .sort((a, b) => b.count - a.count)
      .map((item) => {
        const el = makeEl(item);
        el.style.position = "absolute";
        el.style.whiteSpace = "nowrap";
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        node.appendChild(el);
        return el;
      });

    // An <img> with only height set reports width 0 until the file arrives, which would stack
    // every emote onto the same spot. decode() settles on load AND on error; the timeout keeps
    // one dead CDN URL from freezing the whole cloud.
    const pending = els
      .filter((el) => el.tagName === "IMG" && !el.complete)
      .map((el) => Promise.race([el.decode().catch(() => {}), new Promise((r) => setTimeout(r, IMAGE_WAIT_MS))]));
    if (pending.length) {
      await Promise.all(pending);
      if (node.__cloudToken !== token) return; // a newer render superseded this one mid-wait
    }

    node.__cloud = { els };
    place(node);

    // Staggered fade-in so a period change reads as a change, not a flicker. transform stays
    // in the transition list so hover:scale-* utilities on emotes keep animating.
    els.forEach((el, i) => {
      el.style.transition = "opacity 300ms ease, transform 150ms ease";
      setTimeout(() => (el.style.opacity = "1"), Math.min(i * 8, 350));
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      for (const node of registry) {
        if (node.isConnected && node.__cloud) place(node);
      }
    }, 150);
  });

  window.CloudLayout = { render };
})();
