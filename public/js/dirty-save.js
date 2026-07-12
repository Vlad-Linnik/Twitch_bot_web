// Shows a form's Save button (.save-fab) only once the form actually differs from its loaded
// state - used by the small single-purpose forms (timeout reason, spam ban reason, detection
// toggle) via a data-dirty-save attribute. The button is hidden from first paint by CSS
// (html.js .save-fab, see input.css), NOT by this script - a deferred script hiding it would
// paint it for a split second first. IIFE: classic scripts share one global scope per page.
(() => {
  for (const dirtyForm of document.querySelectorAll("form[data-dirty-save]")) {
    const saveButton = dirtyForm.querySelector(".save-fab");
    if (!saveButton) continue;

    const initialState = new URLSearchParams(new FormData(dirtyForm)).toString();
    const update = () => {
      const dirty = new URLSearchParams(new FormData(dirtyForm)).toString() !== initialState;
      saveButton.classList.toggle("save-visible", dirty);
    };

    dirtyForm.addEventListener("input", update);
    dirtyForm.addEventListener("change", update);
  }
})();
