const form = document.getElementById("logout-form");
const dialog = document.getElementById("logout-confirm-dialog");

if (form && dialog) {
  form.addEventListener("submit", (event) => {
    // A dirty form elsewhere on the page (settings-form.js) takes priority -
    // losing unsaved changes is the more important warning of the two.
    if (window.hasUnsavedFormChanges?.()) {
      event.preventDefault();
      window.confirmLeaveUnsaved(() => form.submit());
      return;
    }
    if (!dialog.open) {
      event.preventDefault();
      dialog.showModal();
    }
  });

  document.getElementById("logout-cancel")?.addEventListener("click", () => dialog.close());

  document.getElementById("logout-confirm")?.addEventListener("click", () => {
    dialog.close();
    form.submit(); // bypasses the submit listener above, unlike requestSubmit()
  });
}
