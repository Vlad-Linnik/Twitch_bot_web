// A movie/game card's own page (views/mediaItem.ejs):
//   - "show 18+ cover": swaps the blurred poster for the normal one. The normal URL is only on
//     this page, in data-full-src; the button is rendered hidden so a no-JS visitor never sees a
//     button that does nothing;
//   - the viewer's 1-10 score: posted by fetch and patched in place (the average, the count, the
//     pressed button, the note on whether it counts). The form posts normally without JS.
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
  const note = document.querySelector("[data-rate-note]");
  const averageEl = document.querySelector("[data-viewer-average]");
  const countEl = document.querySelector("[data-viewer-count]");

  form.addEventListener("submit", async (event) => {
    const submitter = event.submitter;
    if (!submitter || !submitter.dataset.rateValue) return;
    event.preventDefault();
    if (form.dataset.busy === "1") return;
    form.dataset.busy = "1";

    const body = new URLSearchParams(new FormData(form));
    body.set("value", submitter.value);
    try {
      const response = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `status ${response.status}`);

      for (const b of form.querySelectorAll("[data-rate-value]")) {
        b.setAttribute("aria-pressed", String(Number(b.value) === data.value));
      }
      if (averageEl) {
        averageEl.textContent = data.average === null ? "—" : data.average.toFixed(1);
        averageEl.classList.toggle("text-sky-400", data.average !== null);
        averageEl.classList.toggle("text-neutral-600", data.average === null);
      }
      if (countEl && countEl.dataset.template !== undefined) {
        countEl.textContent = countEl.dataset.template.replace("{{count}}", String(data.count));
      }
      if (note) note.textContent = data.counted ? note.dataset.noteCounted : note.dataset.noteNotCounted;
    } catch {
      if (note) note.textContent = note.dataset.noteError;
    } finally {
      form.dataset.busy = "0";
    }
  });
})();
