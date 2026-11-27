// The rating animation shared by the movie/game grid (public/js/media-quick-rate.js) and a card's
// own page (public/js/media-item.js). Web Animations only - nothing here needs a CSS rule, so the
// stylesheet build does not have to know about it.
//
//   starBurst(svg, { clear })  - the score's star: a coin spin (two full turns about the vertical
//                                axis) that swells and glows at the top, then a ring and a spray of
//                                small stars and sparks from its centre. `clear` is the reverse: a
//                                short backward twist that sinks, no spray.
//   starCascade(svgs)          - the picker's lit stars pop one after another, left to right. Each
//                                turns by 144deg: a five-pointed star is the same shape every 72deg,
//                                so it lands exactly as it started and the turn reads as a twirl.
//
// With prefers-reduced-motion both shrink to a single gentle pulse.
// Plain script sharing the page's global scope: only the two functions leave the IIFE.
(() => {
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STAR = "M10 1.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6L10 15l-5.4 3 1.2-6L1.3 7.8l6.1-.7z";
  const can = (el) => el && typeof el.animate === "function";

  function pulse(el) {
    el.animate([{ transform: "scale(1)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  }

  // A fixed layer over the element's centre, removed when its last animation ends.
  function layerAt(el) {
    const rect = el.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = `position:fixed;left:${rect.left + rect.width / 2}px;top:${rect.top + rect.height / 2}px;width:0;height:0;pointer-events:none;z-index:60;`;
    document.body.appendChild(layer);
    return { layer, size: Math.max(rect.width, rect.height) };
  }

  function piece(layer, html, size) {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:${-size / 2}px;top:${-size / 2}px;width:${size}px;height:${size}px;`;
    el.innerHTML = html;
    layer.appendChild(el);
    return el;
  }

  function spray(el) {
    const color = getComputedStyle(el).color;
    const { layer, size } = layerAt(el);
    const anims = [];

    // The shock ring, in the star's own colour.
    const ring = piece(layer, "", size);
    ring.style.borderRadius = "50%";
    ring.style.border = `2px solid ${color}`;
    anims.push(ring.animate(
      [{ transform: "scale(.3)", opacity: 0.95 }, { transform: "scale(2.8)", opacity: 0 }],
      { duration: 620, delay: 180, easing: "cubic-bezier(.15,.7,.3,1)", fill: "backwards" }
    ));

    // Small stars and sparks, evenly round the circle with a little jitter so it never looks drawn.
    const palette = [color, color, "#fde68a", "#ffffff"];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.45;
      const distance = size * (1.3 + Math.random() * 1.2);
      const isStar = i % 2 === 0;
      const s = isStar ? 7 + Math.random() * 5 : 3 + Math.random() * 2;
      const tint = palette[i % palette.length];
      const p = piece(
        layer,
        isStar
          ? `<svg viewBox="0 0 20 20" width="${s}" height="${s}" fill="${tint}" style="display:block;filter:drop-shadow(0 0 2px ${tint})"><path d="${STAR}"/></svg>`
          : "",
        s
      );
      if (!isStar) {
        p.style.borderRadius = "50%";
        p.style.background = tint;
        p.style.boxShadow = `0 0 4px ${tint}`;
      }
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      const spin = (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 360);
      anims.push(p.animate(
        [
          { transform: "translate(0,0) scale(.2) rotate(0deg)", opacity: 0 },
          { transform: `translate(${dx * 0.55}px,${dy * 0.55}px) scale(1.15) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.35 },
          // A touch of gravity at the end, so the spray falls rather than freezes.
          { transform: `translate(${dx}px,${dy + size * 0.35}px) scale(.4) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: 700 + Math.random() * 300, delay: 200 + Math.random() * 60, easing: "cubic-bezier(.2,.8,.3,1)", fill: "backwards" }
      ));
    }
    Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => layer.remove());
  }

  window.starBurst = function starBurst(el, { clear = false } = {}) {
    if (!can(el)) return;
    if (reduced()) return pulse(el);
    if (clear) {
      el.animate(
        [
          { transform: "rotate(0deg) scale(1)", opacity: 1 },
          { transform: "rotate(-90deg) scale(.6)", opacity: 0.5, offset: 0.55 },
          { transform: "rotate(-144deg) scale(1)", opacity: 1 },
        ],
        { duration: 520, easing: "cubic-bezier(.3,.1,.3,1)" }
      );
      return;
    }
    el.animate(
      [
        { transform: "perspective(120px) rotateY(0deg) scale(1)", filter: "drop-shadow(0 0 0 transparent)" },
        { transform: "perspective(120px) rotateY(420deg) scale(1.75)", filter: "drop-shadow(0 0 7px currentColor) brightness(1.35)", offset: 0.38 },
        { transform: "perspective(120px) rotateY(660deg) scale(.88)", filter: "drop-shadow(0 0 4px currentColor)", offset: 0.72 },
        { transform: "perspective(120px) rotateY(720deg) scale(1)", filter: "drop-shadow(0 0 0 transparent)" },
      ],
      { duration: 950, easing: "cubic-bezier(.25,.75,.25,1)" }
    );
    spray(el);
  };

  window.starCascade = function starCascade(els) {
    const list = [...els].filter(can);
    if (reduced()) return list.forEach(pulse);
    list.forEach((el, i) => {
      el.animate(
        [
          { transform: "rotate(0deg) scale(1)" },
          { transform: "rotate(90deg) scale(1.45)", filter: "drop-shadow(0 0 5px currentColor)", offset: 0.5 },
          { transform: "rotate(144deg) scale(1)" },
        ],
        { duration: 420, delay: i * 38, easing: "cubic-bezier(.3,.7,.3,1)", fill: "backwards" }
      );
    });
  };
})();
