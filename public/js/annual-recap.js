// The personal recap's guessing game (views/annualRecapMe.ejs). Every fact starts hidden behind
// its question (html.js .recap-locked); answering reveals it and marks the right option, and once
// every question is answered - or "show everything" is pressed - the rest of the page opens.
// Without JS nothing is hidden in the first place.
(function () {
  "use strict";

  const root = document.querySelector("[data-recap-quiz]");
  if (!root) return;
  const cards = Array.from(root.querySelectorAll("[data-quiz]"));
  const rest = document.querySelector("[data-quiz-rest]");
  const skip = root.querySelector("[data-quiz-skip]");

  function unlock(el) {
    if (el) el.classList.remove("recap-locked");
  }

  function settle(card, picked) {
    if (card.dataset.done) return;
    card.dataset.done = "1";
    const answer = Number(card.dataset.answer);
    card.querySelectorAll("[data-option]").forEach(function (btn) {
      const i = Number(btn.dataset.option);
      btn.disabled = true;
      if (i === answer) btn.classList.add("recap-option-right");
      else if (i === picked) btn.classList.add("recap-option-wrong");
      else btn.classList.add("recap-option-dim");
    });
    unlock(card.querySelector("[data-quiz-reveal]"));
    if (cards.every(function (c) { return c.dataset.done; })) finish();
  }

  function finish() {
    unlock(rest);
    if (skip) skip.hidden = true;
  }

  cards.forEach(function (card) {
    card.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-option]");
      if (!btn || btn.disabled) return;
      settle(card, Number(btn.dataset.option));
    });
  });

  if (skip) {
    skip.addEventListener("click", function () {
      cards.forEach(function (card) { settle(card, -1); });
      finish();
    });
  }

  if (cards.length === 0) finish();
})();
