// «Премия чата» voting without a page reload (views/annualRecapAwards.ejs). Each vote is the same
// form POST the no-JS page sends; this only asks for JSON back and moves the "your vote" mark
// inside that one award, so the page does not jump back to the top after every click.
(function () {
  "use strict";

  const root = document.querySelector("[data-awards]");
  if (!root) return;

  const ON = ["border-purple-500", "bg-purple-600", "text-white"];
  const OFF = ["border-neutral-700", "text-neutral-300", "hover:border-purple-500"];
  const ROW_ON = ["border-purple-500/70", "bg-purple-950/30"];
  const ROW_OFF = ["border-neutral-800", "bg-black/20"];

  function mark(section, nomineeId) {
    section.querySelectorAll("[data-nominee]").forEach(function (row) {
      const mine = row.dataset.nominee === nomineeId;
      const btn = row.querySelector(".vote-btn");
      row.classList.remove.apply(row.classList, mine ? ROW_OFF : ROW_ON);
      row.classList.add.apply(row.classList, mine ? ROW_ON : ROW_OFF);
      if (!btn) return;
      btn.classList.remove.apply(btn.classList, mine ? OFF : ON);
      btn.classList.add.apply(btn.classList, mine ? ON : OFF);
      btn.textContent = mine ? btn.dataset.labelMine : btn.dataset.labelVote;
    });
  }

  root.addEventListener("submit", function (event) {
    const form = event.target.closest("[data-vote-form]");
    if (!form) return;
    event.preventDefault();
    const section = form.closest("[data-award]");
    const buttons = section.querySelectorAll(".vote-btn");
    buttons.forEach(function (b) { b.disabled = true; });
    fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: "same-origin",
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (data) {
        if (data && data.ok) mark(section, data.nominee);
        else form.submit(); // let the server explain in a full page
      })
      .catch(function () { form.submit(); })
      .finally(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  });
})();
