// A movie/game card's own page (views/mediaItem.ejs):
//   - "show 18+ cover": swaps the blurred poster for the normal one. The normal URL is only on
//     this page, in data-full-src; the button is rendered hidden so a no-JS visitor never sees a
//     button that does nothing;
//   - the viewer's 1-10 stars. The server draws a working form (ten submit buttons, the current
//     score's star posting "clear"); this adds what a form cannot do:
//       * preview - hovering or focusing a star lights it and every star before it;
//       * keyboard - one tab stop for the whole row (roving tabindex, the radiogroup pattern),
//         arrows / Home / End move and preview, Enter or Space rates;
//       * re-clicking your own score takes it back;
//       * the post goes by fetch and the average, the count, the stars and the note are patched in
//         place.
// Plain script sharing the page's global scope: everything stays inside the IIFE.
(() => {
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

  const form = document.querySelector("[data-rate-form]");
  if (!form) return;
  const group = form.querySelector("[data-stars]");
  const stars = [...form.querySelectorAll("[data-star]")];
  const readout = form.querySelector("[data-star-readout]");
  const note = document.querySelector("[data-rate-note]");
  const averageEl = document.querySelector("[data-viewer-average]");
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
    if (readout) readout.textContent = current ? `${current}/10` : "";
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
      if (averageEl) {
        const has = data.average !== null && data.average !== undefined;
        averageEl.textContent = has ? data.average.toFixed(1) : "—";
        averageEl.classList.toggle("text-white", has);
        averageEl.classList.toggle("text-stone-600", !has);
        if (averageStar) {
          averageStar.classList.toggle("text-amber-300", has);
          averageStar.classList.toggle("text-stone-700", !has);
        }
      }
      if (countEl) {
        countEl.textContent = data.count ? countEl.dataset.template.replace("{{count}}", String(data.count)) : countEl.dataset.none;
      }
      if (note) note.textContent = clearing ? note.dataset.noteCleared : data.counted ? note.dataset.noteCounted : note.dataset.noteNotCounted;
    } catch {
      paint(current);
      if (note) note.textContent = note.dataset.noteError;
    } finally {
      form.dataset.busy = "0";
    }
  });

  sync();
})();
