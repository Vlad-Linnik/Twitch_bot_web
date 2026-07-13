// /<channel>/counters - progressive enhancement only, same shape as custom-commands.js.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, delete is a
// plain POST. This file adds two things on top - loading a row back into the form to edit it,
// and a delete confirmation.
(function () {
  "use strict";

  const form = document.getElementById("counter-form");
  if (!form) return;

  const name = document.getElementById("name");
  const count = document.getElementById("count");
  const access = document.getElementById("access");
  const heading = document.getElementById("form-heading");
  const cancel = document.getElementById("cancel-edit");

  const originalHeading = heading.textContent;

  // --- Edit: copy an existing counter back into the form. The form POSTs an upsert, so editing
  // and creating are literally the same request - there is no separate edit endpoint.
  document.querySelectorAll(".js-edit").forEach((button) => {
    button.addEventListener("click", () => {
      name.value = button.dataset.name;
      count.value = button.dataset.count;
      access.value = button.dataset.access;

      heading.textContent = `${originalHeading} — #${button.dataset.name}`;
      cancel.hidden = false;

      form.scrollIntoView({ behavior: "smooth", block: "start" });
      count.focus();
    });
  });

  cancel.addEventListener("click", () => {
    heading.textContent = originalHeading;
    cancel.hidden = true;
  });

  // --- Deleting a counter is destructive and not undoable - confirm it.
  document.querySelectorAll(".js-delete-form").forEach((deleteForm) => {
    deleteForm.addEventListener("submit", (event) => {
      const counterName = deleteForm.querySelector('input[name="name"]').value;
      const message = deleteForm.dataset.confirm || "";
      if (!window.confirm(`${message} #${counterName}`.trim())) event.preventDefault();
    });
  });
})();
