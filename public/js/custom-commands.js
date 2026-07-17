// /<channel>/settings/custom-commands/commands - progressive enhancement only.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, delete and
// the enable/disable toggle are plain POSTs, and the category-override rows fall back to a fixed
// <noscript> set (views/customCommands.ejs). This file adds on top - loading a row back into the
// form to edit it, warning about the timer+pin conflict before the server has to reject it, a
// delete confirmation, and rendering the category-override rows one at a time instead of a fixed
// block of five.
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

  // --- Category-override rows: rendered one at a time instead of a fixed block. A row is only
  // added once the previous one is fully filled in, up to maxCategoryOverrides.
  const categoryToggle = document.getElementById("categoryOverridesEnable");
  const categoryContainer = document.getElementById("category-rows");
  const categoryTemplate = document.getElementById("category-row-template");
  const maxCategoryRows = parseInt(categoryContainer.dataset.max, 10) || 0;

  function categoryRows() {
    return Array.from(categoryContainer.children);
  }

  function addCategoryRow() {
    if (categoryRows().length >= maxCategoryRows) return null;
    const row = categoryTemplate.content.firstElementChild.cloneNode(true);
    categoryContainer.appendChild(row);
    return row;
  }

  // The last row's two inputs, filled in, is what triggers the next blank row to appear.
  function maybeAddCategoryRow() {
    const rows = categoryRows();
    if (!rows.length) return;
    const last = rows[rows.length - 1];
    const [catInput, textInput] = last.querySelectorAll("input");
    if (catInput.value.trim() && textInput.value.trim()) addCategoryRow();
  }

  function clearCategoryRows() {
    categoryContainer.innerHTML = "";
  }

  categoryContainer.addEventListener("input", maybeAddCategoryRow);

  categoryToggle.addEventListener("change", () => {
    categoryContainer.hidden = !categoryToggle.checked;
    if (categoryToggle.checked && !categoryRows().length) addCategoryRow();
  });

  // Fills the rows from an existing command's overrides, plus one trailing blank row to continue
  // adding more (if there's room left under the max).
  function fillCategoryRows(overrides) {
    clearCategoryRows();
    if (!overrides.length) {
      categoryToggle.checked = false;
      categoryContainer.hidden = true;
      return;
    }
    categoryToggle.checked = true;
    categoryContainer.hidden = false;
    overrides.forEach((ov) => {
      const row = addCategoryRow();
      if (!row) return;
      const [catInput, textInput] = row.querySelectorAll("input");
      catInput.value = ov.category || "";
      textInput.value = ov.result || "";
    });
    addCategoryRow();
  }

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

      let overrides = [];
      try {
        overrides = JSON.parse(button.dataset.categoryTexts || "[]");
      } catch {
        overrides = [];
      }
      fillCategoryRows(overrides);

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
    clearCategoryRows();
    categoryToggle.checked = false;
    categoryContainer.hidden = true;
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
