// Home-page stat tiles: periodic refresh + odometer-style digit roll on change.
//
// Vanilla, no odometer library - same convention as the rest of public/js. The four tiles
// carry data-stat (key into /stats.json) and data-value (the raw number, so we never parse
// locale-formatted text back into a number). Polling is gentle on purpose: 30s, skipped
// while the tab is hidden, against an endpoint that costs three small reads (see
// routes/home.js) behind statsReadLimiter.
(function () {
  "use strict";

  const tiles = document.querySelectorAll("[data-stat][data-value]");
  if (tiles.length === 0) return;

  const locale = document.documentElement.lang || undefined;
  const fmt = new Intl.NumberFormat(locale);

  // One character of the display: .od-char > .od-col > <span>ch</span>. Separators get the
  // exact same structure as digits - .od-char is overflow:hidden inline-block, which moves
  // its baseline to its bottom edge, so a bare-text separator would sit misaligned next to
  // wrapped digits (see the .od-char comment in input.css).
  function charSpan(ch) {
    const wrap = document.createElement("span");
    wrap.className = "od-char";
    const col = document.createElement("span");
    col.className = "od-col";
    const cur = document.createElement("span");
    cur.textContent = ch;
    col.appendChild(cur);
    wrap.appendChild(col);
    return wrap;
  }

  // Replace the tile's text with the odometer structure, no animation. Also re-formats with
  // the CLIENT's Intl - the server rendered the same locale, but if the two ICUs ever
  // disagree on separators this makes the first poll compare like with like.
  function build(tile, value) {
    tile.dataset.current = fmt.format(value);
    tile.textContent = "";
    for (const ch of tile.dataset.current) tile.appendChild(charSpan(ch));
  }

  function update(tile, value) {
    const nextStr = fmt.format(value);
    const prevStr = tile.dataset.current;
    if (nextStr === prevStr) return;
    tile.dataset.current = nextStr;

    // Align old vs new from the RIGHT, so a length change (9 999 -> 10 000) keeps the low
    // digits matched up and rolls the new leading characters in from nothing.
    const pad = nextStr.length - prevStr.length;
    const rolling = [];

    tile.textContent = "";
    [...nextStr].forEach((ch, i) => {
      const oldCh = i - pad >= 0 && i - pad < prevStr.length ? prevStr[i - pad] : "";
      const wrap = charSpan(ch);
      if (oldCh !== ch) {
        // Stack [old, new] in the column; sliding up one row reveals the new character.
        const col = wrap.firstChild;
        col.textContent = "";
        const oldSpan = document.createElement("span");
        oldSpan.textContent = oldCh;
        const newSpan = document.createElement("span");
        newSpan.textContent = ch;
        col.append(oldSpan, newSpan);
        rolling.push({ col, ch });
      }
      tile.appendChild(wrap);
    });

    // Flush styles so the un-rolled state is committed, then animate (same trick as
    // user-dashboard.js's chart transitions).
    void tile.getBoundingClientRect();
    for (const { col, ch } of rolling) {
      col.classList.add("od-roll");
      col.addEventListener(
        "transitionend",
        () => {
          const single = document.createElement("span");
          single.textContent = ch;
          col.classList.remove("od-roll"); // removing the class drops the transition, so no snap-back animation
          col.replaceChildren(single);
        },
        { once: true }
      );
    }
  }

  tiles.forEach((tile) => build(tile, Number(tile.dataset.value)));

  const POLL_MS = 30000;
  let lastFetch = Date.now(); // the server just rendered fresh numbers

  async function poll() {
    if (document.hidden) return;
    lastFetch = Date.now();
    try {
      const res = await fetch("/stats.json", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      tiles.forEach((tile) => {
        const value = data[tile.dataset.stat];
        if (typeof value === "number") update(tile, value);
      });
    } catch {
      // Transient network failure - the next tick simply retries.
    }
  }

  setInterval(poll, POLL_MS);
  // Coming back to a long-hidden tab: refresh immediately rather than waiting out the tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastFetch > POLL_MS) poll();
  });
})();
