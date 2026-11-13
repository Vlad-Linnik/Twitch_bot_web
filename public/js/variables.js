// /<channel>/variables - progressive enhancement only, same shape as custom-commands.js.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, delete is a
// plain POST. This file adds two things on top - loading a row back into the form to edit it,
// and a delete confirmation.
(function () {
  "use strict";

  const form = document.getElementById("variable-form");
  if (!form) return;

  const name = document.getElementById("name");
  const value = document.getElementById("value");
  const access = document.getElementById("access");
  const heading = document.getElementById("form-heading");
  const cancel = document.getElementById("cancel-edit");

  const originalHeading = heading.textContent;

  // --- Edit: copy an existing variable back into the form. The form POSTs an upsert, so editing
  // and creating are literally the same request - there is no separate edit endpoint.
  document.querySelectorAll(".js-edit").forEach((button) => {
    button.addEventListener("click", () => {
      name.value = button.dataset.name;
      value.value = button.dataset.value;
      access.value = button.dataset.access;

      heading.textContent = `${originalHeading} — #${button.dataset.name}`;
      cancel.hidden = false;

      form.scrollIntoView({ behavior: "smooth", block: "start" });
      value.focus();
    });
  });

  cancel.addEventListener("click", () => {
    heading.textContent = originalHeading;
    cancel.hidden = true;
  });

  // --- Deleting a variable is destructive and not undoable - confirm it.
  document.querySelectorAll(".js-delete-form").forEach((deleteForm) => {
    deleteForm.addEventListener("submit", (event) => {
      const variableName = deleteForm.querySelector('input[name="name"]').value;
      const message = deleteForm.dataset.confirm || "";
      if (!window.confirm(`${message} #${variableName}`.trim())) event.preventDefault();
    });
  });
})();
