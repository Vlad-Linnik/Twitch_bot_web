// /<channel>/settings/custom-commands/commands - progressive enhancement only.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, delete and
// the enable/disable toggle are plain POSTs, and the category-override rows fall back to a fixed
// <noscript> set (views/customCommands.ejs). This file adds on top - loading a row back into the
// form to edit it, warning about the timer+pin conflict before the server has to reject it, a
// delete confirmation, rendering the category-override rows one at a time instead of a fixed
// block of five, and the alias chip-list below.
(function () {
  "use strict";

  const form = document.getElementById("command-form");
  if (!form) return;

  const name = document.getElementById("name");
  const nameError = document.getElementById("name-error");
  const result = document.getElementById("result");
  const timer = document.getElementById("timerSeconds");
  const pin = document.getElementById("pin");
  const announce = document.getElementById("announce");
  const announceColor = document.getElementById("announceColor");
  const modOnly = document.getElementById("modOnly");
  const heading = document.getElementById("form-heading");
  const cancel = document.getElementById("cancel-edit");
  const conflict = document.getElementById("pin-conflict");
  const announceConflict = document.getElementById("announce-conflict");

  const originalHeading = heading.textContent;

  // --- Aliases: a chip list instead of a raw comma-separated text field - each synonym is added
  // one at a time (via the "+" button, Enter, or typing a comma) and can be removed individually,
  // entirely client-side so neither action reloads the page. The chip list is the source of truth
  // in the browser; the actual field the form submits is the hidden #aliases input, kept in sync
  // by renderAliasChips() on every change.
  const aliasInput = document.getElementById("alias-input");
  const aliasAdd = document.getElementById("alias-add");
  const aliasChipsEl = document.getElementById("alias-chips");
  const aliasesHidden = document.getElementById("aliases");
  const aliasError = document.getElementById("alias-error");
  // Mirrors lib/commandValidation.js's NAME_PATTERN/MAX_NAME_LENGTH - aliases are matched by the
  // bot with the exact same startsWith-prefix logic as a command's own name, so they must obey
  // the exact same character set. Kept in sync by hand, same convention as that file's own mirror
  // of the bot's chat-side regex.
  const NAME_PATTERN = /^[a-zа-я0-9]+$/;
  const MAX_NAME_LENGTH = 30;
  const maxAliases = parseInt(aliasError.dataset.max, 10) || 5;
  // Every other command's {command, aliases} in this channel, snapshotted at page load - used
  // only for the instant "already taken by !x" hint below. The server (checkAliasConflicts in
  // lib/commandValidation.js) re-checks against live data on submit regardless, so a stale
  // snapshot (another mod saving a command in another tab) can't let a real conflict through -
  // it would just fail to warn about it until the round-trip.
  let allCommands = [];
  try {
    allCommands = JSON.parse(document.getElementById("commands-data").textContent || "[]");
  } catch {
    allCommands = [];
  }
  let aliasList = [];
  // The command currently loaded into the form for editing (button.dataset.name), or null while
  // creating a new one - excluded from conflict checks so a command doesn't collide with itself.
  let editingCommand = null;

  // Same normalization the server applies (lib/commandValidation.js's normalizeName): trim,
  // lowercase, drop a leading "!" if someone types the command the way they'd type it in chat.
  // Applied live (on blur/add) instead of only silently on submit, so a mod who typed "Hello"
  // immediately sees it become "hello" and understands why, rather than wondering if the save
  // "did something" to their input.
  function normalize(raw) {
    return String(raw || "").trim().toLowerCase().replace(/^!/, "");
  }

  // Finds which OTHER command (if any) already owns `trigger` as its name or one of its aliases.
  function findOwner(trigger) {
    for (const c of allCommands) {
      if (c.command === editingCommand) continue;
      if (c.command === trigger) return c.command;
      if ((c.aliases || []).includes(trigger)) return c.command;
    }
    return null;
  }

  function renderAliasChips() {
    aliasChipsEl.innerHTML = "";
    aliasList.forEach((alias) => {
      const chip = document.createElement("span");
      chip.className = "inline-flex items-center gap-1 text-xs pl-2 pr-1 py-1 rounded-full bg-neutral-800 text-neutral-300 border border-neutral-700";
      const text = document.createElement("span");
      text.textContent = `!${alias}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "text-neutral-500 hover:text-red-400 leading-none px-1";
      removeBtn.setAttribute("aria-label", aliasChipsEl.dataset.removeLabel || "×");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        aliasList = aliasList.filter((a) => a !== alias);
        renderAliasChips();
      });
      chip.appendChild(text);
      chip.appendChild(removeBtn);
      aliasChipsEl.appendChild(chip);
    });
    aliasesHidden.value = aliasList.join(", ");
  }

  function showAliasError(message) {
    aliasError.textContent = message;
    aliasError.hidden = false;
  }

  function hideAliasError() {
    aliasError.hidden = true;
  }

  // Parses whatever's currently in the alias text box (comma/space-separated, so pasting "hi, hey"
  // works too) and adds it to the chip list. Validates the WHOLE batch before adding anything -
  // one bad piece blocks the batch and leaves the text box untouched so the mod can fix it,
  // rather than silently dropping just the bad one.
  function tryAddAliases() {
    const pieces = aliasInput.value.split(/[,\s]+/).map(normalize).filter(Boolean);
    if (!pieces.length) return;

    const currentName = normalize(name.value);
    const toAdd = [];
    for (const piece of pieces) {
      if (piece.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(piece)) {
        showAliasError(aliasError.dataset.msgInvalid);
        return;
      }
      if (currentName && piece === currentName) {
        showAliasError(aliasError.dataset.msgMatchesName);
        return;
      }
      if (aliasList.includes(piece) || toAdd.includes(piece)) continue; // already have it - dedupe silently
      const owner = findOwner(piece);
      if (owner) {
        showAliasError(aliasError.dataset.msgConflict.replace("%s", owner));
        return;
      }
      toAdd.push(piece);
    }
    if (aliasList.length + toAdd.length > maxAliases) {
      showAliasError(aliasError.dataset.msgTooMany);
      return;
    }

    aliasList = aliasList.concat(toAdd);
    aliasInput.value = "";
    hideAliasError();
    renderAliasChips();
  }

  aliasAdd.addEventListener("click", tryAddAliases);
  // Enter or a typed comma commits the current text immediately, same as a tag-input control -
  // preventDefault stops Enter from submitting the whole form and stops the comma from landing
  // in the box (tryAddAliases already treats it as a separator).
  aliasInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      tryAddAliases();
    }
  });

  // --- Command name: same live normalization as aliases, plus a conflict check against every
  // other command's name/aliases (mirrors lib/commandValidation.js's checkAliasConflicts, minus
  // the alias half - that's handled by findOwner/tryAddAliases above).
  function validateName() {
    const normalized = normalize(name.value);
    name.value = normalized;
    if (!normalized) {
      nameError.hidden = true;
      return true;
    }
    const owner = findOwner(normalized);
    if (owner) {
      nameError.textContent = nameError.dataset.msgConflict.replace("%s", owner);
      nameError.hidden = false;
      return false;
    }
    nameError.hidden = true;
    return true;
  }

  name.addEventListener("blur", validateName);

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
      editingCommand = button.dataset.name;
      aliasList = (button.dataset.aliases || "").split(",").map((a) => a.trim()).filter(Boolean);
      aliasInput.value = "";
      hideAliasError();
      nameError.hidden = true;
      renderAliasChips();
      result.value = button.dataset.result;
      timer.value = button.dataset.timer;
      pin.checked = button.dataset.pin === "1";
      announce.checked = button.dataset.announce === "1";
      if (button.dataset.announceColor) announceColor.value = button.dataset.announceColor;
      modOnly.checked = button.dataset.modOnly === "1";

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
    editingCommand = null;
    aliasList = [];
    aliasInput.value = "";
    hideAliasError();
    renderAliasChips();
    nameError.hidden = true;
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
    if (!validateName()) {
      event.preventDefault();
      nameError.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Commit whatever's still sitting in the alias text box - a mod who typed a synonym and hit
    // submit without clicking "+" shouldn't silently lose it.
    if (aliasInput.value.trim()) {
      const before = aliasList.length;
      tryAddAliases();
      // tryAddAliases only leaves text behind on a validation error (a successful add, including
      // an all-duplicates no-op, always clears the box) - that's the signal to block submission.
      if (aliasInput.value.trim() && aliasList.length === before) {
        event.preventDefault();
        aliasError.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }

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
