// /<channel>/commands - progressive enhancement only.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, delete is a
// plain POST. This file adds three things on top - loading a row back into the form to edit it,
// warning about the timer+pin conflict before the server has to reject it, and a delete
// confirmation.
(function () {
  "use strict";

  const form = document.getElementById("command-form");
  if (!form) return;

  const name = document.getElementById("name");
  const result = document.getElementById("result");
  const timer = document.getElementById("timerSeconds");
  const pin = document.getElementById("pin");
  const announce = document.getElementById("announce");
  const announceColor = document.getElementById("announceColor");
  const heading = document.getElementById("form-heading");
  const cancel = document.getElementById("cancel-edit");
  const conflict = document.getElementById("pin-conflict");
  const announceConflict = document.getElementById("announce-conflict");

  const originalHeading = heading.textContent;

  // --- Edit: copy an existing command back into the form. The form POSTs an upsert, so editing
  // and creating are literally the same request - there is no separate edit endpoint to keep in
  // sync.
  document.querySelectorAll(".js-edit").forEach((button) => {
    button.addEventListener("click", () => {
      name.value = button.dataset.name;
      result.value = button.dataset.result;
      timer.value = button.dataset.timer;
      pin.checked = button.dataset.pin === "1";
      announce.checked = button.dataset.announce === "1";
      if (button.dataset.announceColor) announceColor.value = button.dataset.announceColor;

      heading.textContent = `${originalHeading} — !${button.dataset.name}`;
      cancel.hidden = false;
      updateConflict();

      form.scrollIntoView({ behavior: "smooth", block: "start" });
      result.focus();
    });
  });

  cancel.addEventListener("click", () => {
    heading.textContent = originalHeading;
    cancel.hidden = true;
    // The reset happens natively (type="reset"); clear the warning after it lands.
    setTimeout(updateConflict, 0);
  });

  // --- timer + pin, and announce + pin, cannot coexist. The bot refuses both combinations and
  // so does the server; this just says so before the round-trip, and stops the submit so the
  // user doesn't lose the form.
  function updateConflict() {
    const timerPinClash = !!timer.value && pin.checked;
    const announcePinClash = announce.checked && pin.checked;
    conflict.hidden = !timerPinClash;
    announceConflict.hidden = !announcePinClash;
    return timerPinClash || announcePinClash;
  }

  timer.addEventListener("input", updateConflict);
  pin.addEventListener("change", updateConflict);
  announce.addEventListener("change", updateConflict);

  form.addEventListener("submit", (event) => {
    if (updateConflict()) {
      event.preventDefault();
      (conflict.hidden ? announceConflict : conflict).scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  // --- Deleting a command is destructive and not undoable - confirm it.
  document.querySelectorAll(".js-delete-form").forEach((deleteForm) => {
    deleteForm.addEventListener("submit", (event) => {
      const cmd = deleteForm.querySelector('input[name="name"]').value;
      if (!window.confirm(`!${cmd}`)) event.preventDefault();
    });
  });
})();
