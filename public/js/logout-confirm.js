const form = document.getElementById("logout-form");
const dialog = document.getElementById("logout-confirm-dialog");

if (form && dialog) {
  form.addEventListener("submit", (event) => {
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
