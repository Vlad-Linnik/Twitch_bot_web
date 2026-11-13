// Movie/game create/edit form (views/mediaForm.ejs): the progress fields follow the type. A film
// is a percentage, so the episode total is hidden and the first label says "%"; a series or an
// anime counts episodes. Without JS both inputs show, with a hint explaining which applies - the
// server reads them by type either way (lib/mediaValidation.js's parseProgress).
(() => {
  const form = document.querySelector("[data-media-form]");
  if (!form) return;
  const type = form.querySelector("[data-media-type]");
  const doneLabel = form.querySelector("[data-progress-done-label]");
  const total = form.querySelector("[data-progress-total]");
  if (!type || !doneLabel || !total) return;

  function sync() {
    const film = type.value === "film";
    doneLabel.textContent = film ? doneLabel.dataset.labelFilm : doneLabel.dataset.labelEpisodes;
    total.hidden = film;
  }
  type.addEventListener("change", sync);
  sync();
})();
