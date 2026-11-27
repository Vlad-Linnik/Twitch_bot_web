// A movie/game card's own page (views/mediaItem.ejs):
//   - "show 18+ cover": swaps the blurred poster for the normal one. The normal URL is only on
//     this page, in data-full-src; the button is rendered hidden so a no-JS visitor never sees a
//     button that does nothing;
//   - the viewer's 1-10 stars, in a popover opened from the "your rating" plate. The server draws a working form (ten submit buttons, the current
//     score's star posting "clear"); this adds what a form cannot do:
//       * preview - hovering or focusing a star lights it and every star before it;
//       * keyboard - one tab stop for the whole row (roving tabindex, the radiogroup pattern),
//         arrows / Home / End move and preview, Enter or Space rates;
//       * re-clicking your own score takes it back;
//       * the post goes by fetch and the average, the count, the stars and the note are patched in
//         place, with public/js/star-burst.js's animation.
//   - "← all films": when this page was opened from the grid, the link goes BACK in history rather
//     than to a fresh grid, so the visitor lands where they were - same scroll, same filters, same
//     cards loaded on scroll (bfcache, or public/js/infinite-list.js's restore on a back_forward
//     load). Opened any other way (a shared link, a new tab) it stays a plain link.
// Plain script sharing the page's global scope: everything stays inside the IIFE.
(() => {
  const backLink = document.querySelector("[data-back-to-grid]");
  if (backLink) {
    backLink.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      let from = null;
      try {
        from = document.referrer ? new URL(document.referrer) : null;
      } catch {
        from = null;
      }
      if (!from || from.origin !== location.origin || from.pathname !== backLink.pathname || history.length < 2) return;
      event.preventDefault();
      // The slide direction comes from the traversal itself (views/partials/head.ejs).
      history.back();
    });
  }

  for (const button of document.querySelectorAll("[data-nsfw-reveal]")) {
    const img = button.parentElement.querySelector("[data-nsfw-poster]");
    if (!img) continue;
    button.hidden = false;
    button.addEventListener("click", () => {
      img.src = img.dataset.fullSrc;
      img.classList.remove("scale-110");
      button.remove();
    });
  }

  // The "your rating" plate's picker is a <details>: open/close comes free, this adds closing on an
  // outside click or Escape, and keeps the panel on screen (it opens to the right of the plate,
  // which near the right edge of a narrow screen would hang off it).
  const popover = document.querySelector("[data-rate-popover]");
  const panel = popover && popover.querySelector("[data-rate-panel]");
  function placePanel() {
    if (!panel) return;
    panel.style.left = "";
    const rect = panel.getBoundingClientRect();
    const overflow = rect.right - (document.documentElement.clientWidth - 8);
    if (overflow > 0) panel.style.left = `${-Math.min(overflow, rect.left - 8)}px`;
  }
  if (popover) {
    popover.addEventListener("toggle", () => {
      if (!popover.open) return;
      placePanel();
      const target = popover.querySelector('[data-star][tabindex="0"]');
      if (target) target.focus();
    });
    document.addEventListener("click", (event) => {
      if (popover.open && !popover.contains(event.target)) popover.open = false;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !popover.open) return;
      popover.open = false;
      popover.querySelector("summary").focus();
    });
    if (popover.open) placePanel();
  }

  const form = document.querySelector("[data-rate-form]");
  if (!form) return;
  const group = form.querySelector("[data-stars]");
  const stars = [...form.querySelectorAll("[data-star]")];
  const readout = document.querySelector("[data-star-readout]");
  const myStar = document.querySelector("[data-my-star]");
  const note = document.querySelector("[data-rate-note]");
  const averageEl = document.querySelector("[data-viewer-average]");
  const streamerEl = document.querySelector("[data-streamer-score]");
  const averageStar = document.querySelector("[data-viewer-star]");
  const countEl = document.querySelector("[data-viewer-count]");
  const fill = (template, n) => template.replace("{{n}}", String(n));

  let current = Number(form.dataset.current) || 0;

  // Lights stars 1..n.
  function paint(n) {
    for (const star of stars) star.dataset.lit = Number(star.dataset.star) <= n ? "1" : "0";
  }

  // Everything that depends on `current`: which star is checked, which one clears, labels, the
  // single tab stop, the readout.
  function sync() {
    for (const star of stars) {
      const n = Number(star.dataset.star);
      const isMine = n === current;
      star.setAttribute("aria-checked", String(isMine));
      star.value = isMine ? "clear" : String(n);
      const label = fill(isMine ? form.dataset.labelClear : form.dataset.labelPick, n);
      star.setAttribute("aria-label", label);
      star.title = label;
      star.tabIndex = n === (current || 1) ? 0 : -1;
    }
    if (readout) {
      readout.textContent = current ? String(current) : "—";
      readout.classList.toggle("text-white", Boolean(current));
      readout.classList.toggle("text-stone-600", !current);
    }
    if (myStar) {
      myStar.classList.toggle("text-(--sec-accent)", Boolean(current));
      myStar.classList.toggle("text-stone-500", !current);
    }
    paint(current);
  }

  for (const star of stars) {
    star.addEventListener("mouseenter", () => paint(Number(star.dataset.star)));
    star.addEventListener("focus", () => paint(Number(star.dataset.star)));
  }
  group.addEventListener("mouseleave", () => paint(current));
  group.addEventListener("focusout", (event) => {
    if (!group.contains(event.relatedTarget)) paint(current);
  });

  group.addEventListener("keydown", (event) => {
    const index = stars.indexOf(document.activeElement);
    if (index === -1) return;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(index + 1, stars.length - 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = stars.length - 1;
    if (next === null) return;
    event.preventDefault();
    stars[index].tabIndex = -1;
    stars[next].tabIndex = 0;
    stars[next].focus();
  });

  form.addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (!submitter || !submitter.dataset.star) return;
    event.preventDefault();
    if (form.dataset.busy === "1") return;
    form.dataset.busy = "1";

    const picked = Number(submitter.dataset.star);
    const clearing = picked === current;
    const body = new URLSearchParams(new FormData(form));
    body.set("value", clearing ? "clear" : String(picked));
    try {
      const response = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `status ${response.status}`);

      current = clearing ? 0 : data.value;
      sync();
      submitter.focus();
      // public/js/star-burst.js: the lit stars twirl in turn, the plate's star spins and sprays.
      if (clearing) {
        if (window.starBurst) window.starBurst(myStar, { clear: true });
      } else {
        if (window.starCascade) window.starCascade(stars.slice(0, current).map((s) => s.querySelector("svg")));
        if (window.starBurst) window.starBurst(myStar);
      }
      // The streamer's own stars set the streamer's plate.
      if (streamerEl && "streamer" in data) {
        const has = Boolean(data.streamer);
        streamerEl.textContent = has ? String(data.streamer) : "—";
        for (const c of ["bg-(--sec-accent)", "text-stone-950", "shadow-lg", "shadow-(--sec-accent)/20"]) streamerEl.classList.toggle(c, has);
        for (const c of ["bg-stone-800", "text-stone-500"]) streamerEl.classList.toggle(c, !has);
      }
      if (averageEl) {
        const has = data.average !== null && data.average !== undefined;
        averageEl.textContent = has ? data.average.toFixed(1) : "—";
        averageEl.classList.toggle("text-white", has);
        averageEl.classList.toggle("text-stone-600", !has);
        if (averageStar) {
          averageStar.classList.toggle("text-(--sec-accent-strong)", has);
          averageStar.classList.toggle("text-stone-700", !has);
        }
      }
      if (countEl) {
        countEl.textContent = data.count ? countEl.dataset.template.replace("{{count}}", String(data.count)) : countEl.dataset.none;
      }
      if (note) note.textContent = clearing ? note.dataset.noteCleared : data.counted ? note.dataset.noteCounted : note.dataset.noteNotCounted;
      // A score that counts needs no reading: the plate already shows it, so the picker closes.
      // One that does not count, or a cleared one, stays open on its note.
      if (popover && !clearing && data.counted) setTimeout(() => { popover.open = false; }, 900);
    } catch {
      paint(current);
      if (note) note.textContent = note.dataset.noteError;
    } finally {
      form.dataset.busy = "0";
    }
  });

  sync();
})();
