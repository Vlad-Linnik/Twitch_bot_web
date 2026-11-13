// Promote / not-now on viewer suggestions (views/partials/suggestionVote.ejs), on the grid and on a
// card's page. The server draws a working form: two submit buttons, the pressed one posting
// "clear". This posts it by fetch and patches the score and both buttons in place, so voting never
// reloads the page or loses the scroll position. Delegated on document, so tiles appended by
// infinite-list.js work without rebinding.
//
// Plain script sharing the page's global scope: everything stays inside the IIFE.
(() => {
  function paint(form, value, score) {
    for (const button of form.querySelectorAll("[data-vote]")) {
      const own = Number(button.dataset.vote);
      const pressed = own === value;
      button.setAttribute("aria-pressed", String(pressed));
      button.value = pressed ? "clear" : String(own);
    }
    const scoreEl = form.querySelector("[data-vote-score]");
    if (scoreEl) {
      scoreEl.textContent = score > 0 ? `+${score}` : String(score);
      scoreEl.classList.toggle("text-emerald-300", score > 0);
      scoreEl.classList.toggle("text-slate-400", score < 0);
      scoreEl.classList.toggle("text-stone-400", score === 0);
    }
  }

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-vote-form]");
    if (!form || !event.submitter || !event.submitter.dataset.vote) return;
    event.preventDefault();
    if (form.dataset.busy === "1") return;
    form.dataset.busy = "1";
    const body = new URLSearchParams(new FormData(form));
    body.set("value", event.submitter.value);
    try {
      const response = await fetch(form.action, { method: "POST", body, headers: { Accept: "application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `status ${response.status}`);
      paint(form, data.value, data.score);
    } catch {
      // The form is unchanged, so the next click retries against the server's real state.
      form.classList.add("animate-pulse");
      setTimeout(() => form.classList.remove("animate-pulse"), 600);
    } finally {
      form.dataset.busy = "0";
    }
  });
})();
