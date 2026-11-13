// Movie/game grid (views/mediaGrid.ejs): changing the sort submits the GET form at once. Without JS
// the visitor presses the form's own button - the form itself is the whole feature.
(() => {
  for (const select of document.querySelectorAll("select[data-autosubmit]")) {
    select.addEventListener("change", () => {
      if (select.form) select.form.requestSubmit ? select.form.requestSubmit() : select.form.submit();
    });
  }
})();
