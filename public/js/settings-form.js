// Progressive enhancement: the Save button starts visible in the server-rendered
// HTML (so it always works with JS disabled) - this only hides it until the form
// actually differs from what was loaded, so there's nothing to lose by clicking it.
// Not named `form` - logout-confirm.js (loaded on every page via nav.ejs) already
// declares a top-level `const form`, and separate classic <script> tags on the same
// page share one global lexical scope, so a duplicate const/let name throws instead
// of shadowing (silently aborting this whole script before anything runs).
const settingsForm = document.getElementById("settings-form");
const saveButton = document.getElementById("save-button");
const unsavedDialog = document.getElementById("unsaved-changes-dialog");

if (settingsForm && saveButton) {
  const initialState = new URLSearchParams(new FormData(settingsForm)).toString();
  saveButton.classList.add("hidden");

  // Cleared once the user picks "leave without saving", so the very next
  // navigation attempt (the one that action itself triggers) isn't re-blocked.
  let bypassGuard = false;
  const isDirty = () => !bypassGuard && new URLSearchParams(new FormData(settingsForm)).toString() !== initialState;

  settingsForm.addEventListener("input", () => saveButton.classList.toggle("hidden", !isDirty()));
  settingsForm.addEventListener("change", () => saveButton.classList.toggle("hidden", !isDirty()));

  // Hooks page-transitions.js's link handler and logout-confirm.js's logout
  // flow check before navigating away - optional chaining makes both no-ops
  // on pages without a dirty-trackable form.
  window.hasUnsavedFormChanges = isDirty;

  let pendingLeaveAction = null;
  window.confirmLeaveUnsaved = (proceed) => {
    pendingLeaveAction = proceed;
    unsavedDialog.showModal();
  };

  document.getElementById("unsaved-changes-leave").addEventListener("click", () => {
    unsavedDialog.close();
    bypassGuard = true;
    pendingLeaveAction?.();
  });

  // Browser back/forward/refresh/tab-close can't be intercepted with custom UI
  // (a deliberate cross-browser restriction against sites hijacking this
  // prompt) - this is the one case still limited to the browser's native dialog.
  window.addEventListener("beforeunload", (event) => {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}
