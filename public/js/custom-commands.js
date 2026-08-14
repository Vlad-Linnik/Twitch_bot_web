// /<channel>/settings/custom-commands/commands - progressive enhancement only.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, the row menu
// and the group sections are <details> (so they open and collapse natively), delete / move-to-
// group / the enable-disable toggle are plain POSTs inside that menu, and the category-override
// rows fall back to a fixed <noscript> set (views/customCommands.ejs). This file adds on top -
// loading a row back into the form to edit it, warning about the timer+pin conflict before the
// server has to reject it, a delete confirmation, rendering the category-override rows one at a
// time instead of a fixed block of five, the alias chip-list, remembering which groups were
// collapsed, and dragging a command from one group into another.
//
// The one thing that is genuinely JS-only is drag-and-drop, and deliberately so: it's a shortcut
// for the move form in each row's "..." menu, never the only way to reach it.
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
  const modal = document.getElementById("command-modal");
  const openCreateBtn = document.getElementById("open-create-modal");
  const modalClose = document.getElementById("modal-close");
  const saveButton = form.querySelector('button[type="submit"]');

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

  // --- Unsaved-changes guard: a snapshot of the form taken the moment the modal opens (create or
  // edit), compared against the live form on every way of closing it (the × button, Cancel, a
  // backdrop click, or Escape). Rather than interrupting with a second dialog, a dirty form just
  // refuses to close - the Save button gets scrolled into view and pulses instead, so the mod's
  // attention lands on the one control that actually keeps the edit. Includes the alias text box's
  // live draft, since it has no name attribute and wouldn't otherwise show up in a FormData-based
  // diff.
  let formSnapshotAtOpen = null;

  function serializeFormState() {
    const data = new FormData(form);
    data.delete("_csrf");
    const parts = [];
    for (const [key, value] of data.entries()) parts.push(`${key}=${value}`);
    parts.sort();
    parts.push(`__aliasDraft=${aliasInput.value}`);
    return parts.join("&");
  }

  function snapshotFormState() {
    formSnapshotAtOpen = serializeFormState();
  }

  function isFormDirty() {
    return formSnapshotAtOpen !== null && serializeFormState() !== formSnapshotAtOpen;
  }

  // Restarting the animation on a class that's already applied (a mod hammering Escape) needs the
  // class removed and the layout flushed first, or the browser just sees "no change" and skips it.
  function pulseSaveButton() {
    saveButton.scrollIntoView({ behavior: "smooth", block: "center" });
    saveButton.classList.remove("cc-save-pulse");
    void saveButton.offsetWidth;
    saveButton.classList.add("cc-save-pulse");
  }

  saveButton.addEventListener("animationend", () => saveButton.classList.remove("cc-save-pulse"));

  // Shared by every way of dismissing the dialog without saving - a dirty form pulses the Save
  // button and stays open instead of closing.
  function requestCloseModal() {
    if (isFormDirty()) {
      pulseSaveButton();
      return;
    }
    modal.close();
  }

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

  // Shared by the modal's "close" event (Cancel, the × button, Escape, a backdrop click, or a
  // successful save all end up closing the dialog - see the modal wiring below) and reused
  // directly rather than duplicated per-caller. form.reset() is called explicitly rather than
  // relying on the button's native type="reset" behaviour, since a successful fetch-based save
  // never gets that native reset for free (submit was preventDefault()'d) - driving it from here
  // for every caller means there's exactly one reset path instead of several slightly different
  // ones.
  function resetFormToCreateMode() {
    form.reset();
    heading.textContent = originalHeading;
    clearCategoryRows();
    categoryToggle.checked = false;
    categoryContainer.hidden = true;
    editingCommand = null;
    aliasList = [];
    aliasInput.value = "";
    hideAliasError();
    renderAliasChips();
    nameError.hidden = true;
    updateConflict();
    formSnapshotAtOpen = null;
  }

  // --- Create/edit modal: a native <dialog> (same convention as views/partials/nav.ejs's
  // logout-confirm dialog and the games' leave-confirm dialogs) instead of a permanently-inline
  // form section. showModal()/close() drive visibility; CSS's shared dialog-pop rule
  // (public/css/input.css) plays the jelly-ish pop-in on open. The "close" event is the single
  // place the form resets back to "create" state, so every way of dismissing the dialog behaves
  // the same regardless of which control (or key) triggered it.
  openCreateBtn.addEventListener("click", () => {
    resetFormToCreateMode();
    snapshotFormState();
    modal.showModal();
    name.focus();
  });

  // Cancel means cancel - it always discards and closes, unguarded, unlike the × button/backdrop/
  // Escape below (those read as an accidental dismissal of the dialog, not an explicit "discard my
  // edit" decision, so they pulse the Save button instead of closing over unsaved changes).
  cancel.addEventListener("click", () => modal.close());
  modalClose.addEventListener("click", requestCloseModal);

  // A click landing on the <dialog> element itself (never a descendant) is a click on its
  // backdrop/edge - dialog has no way to distinguish that from a normal click otherwise.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) requestCloseModal();
  });

  // Escape fires a cancelable "cancel" event before the dialog actually closes - block it the same
  // way requestCloseModal() blocks the other close paths, so Escape doesn't bypass the guard.
  modal.addEventListener("cancel", (event) => {
    if (isFormDirty()) {
      event.preventDefault();
      pulseSaveButton();
    }
  });

  modal.addEventListener("close", resetFormToCreateMode);

  // The classic no-JS-fallback redirect (?error=...) lands on a fresh render with the dialog
  // closed and the error banner above it floating with no visible form to explain - reopen the
  // dialog automatically so the two are seen together.
  if (modal.dataset.openOnError) modal.showModal();

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

  // --- Save toast: a small fade-in/fade-out notification (views/customCommands.ejs's #save-toast)
  // instead of the old always-visible top banner. Fires from two places: a landing page load after
  // a classic redirect (saved=1/deleted - the no-JS fallback, or a toggle's fail-soft fallback)
  // and, with JS, directly from a successful fetch-based save/delete with no reload at all.
  const toastEl = document.getElementById("save-toast");
  const toastBody = document.getElementById("save-toast-body");
  let toastTimer = null;

  function showToast(text) {
    if (!toastEl || !text) return;
    toastBody.textContent = text;
    toastEl.classList.remove("opacity-0", "translate-y-2", "pointer-events-none");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add("opacity-0", "translate-y-2", "pointer-events-none");
    }, 2500);
  }

  if (toastEl && toastEl.dataset.initialSaved) {
    showToast(toastEl.dataset.initialSaved === "deleted" ? toastEl.dataset.deletedText : toastEl.dataset.savedText);
    // Drop ?saved=... from the URL so refreshing the page doesn't replay the toast.
    const url = new URL(location.href);
    url.searchParams.delete("saved");
    history.replaceState(null, "", url);
  }

  // --- Existing-commands list: re-wired after every fetch-based swap (submitCommandForm,
  // wireToggleForm below), since replacing #commands-list's innerHTML drops whatever listeners
  // were attached to the elements it just threw away. The container element itself is never
  // replaced (only its innerHTML), so listeners delegated onto IT - the drag-and-drop handlers
  // and the menu bookkeeping below - survive a swap and are attached exactly once.
  const commandsList = document.getElementById("commands-list");

  // --- Collapsed groups. The open/closed state is the <details> element's own, so all this does
  // is remember which groups were collapsed across a list re-render (and across visits): the
  // server always renders every section open, and applyCollapsedState() closes the remembered
  // ones again immediately after each swap. Keyed per channel so two channels' lists don't share
  // it. A browser with storage disabled just loses the memory, never the collapsing itself.
  const collapsedKey = `cc-collapsed:${commandsList.dataset.channel || ""}`;

  function readCollapsed() {
    try {
      const stored = JSON.parse(localStorage.getItem(collapsedKey) || "[]");
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  }

  function writeCollapsed(set) {
    try {
      localStorage.setItem(collapsedKey, JSON.stringify([...set]));
    } catch {
      /* storage unavailable (private mode, quota) - collapsing still works, it just won't stick */
    }
  }

  function applyCollapsedState() {
    const collapsed = readCollapsed();
    commandsList.querySelectorAll("details.cc-group").forEach((section) => {
      section.open = !collapsed.has(section.dataset.group);
      // `toggle` doesn't bubble, so this can't be delegated onto the container like the drag
      // handlers - it has to be re-attached to each freshly rendered section.
      section.addEventListener("toggle", () => {
        const set = readCollapsed();
        if (section.open) set.delete(section.dataset.group);
        else set.add(section.dataset.group);
        writeCollapsed(set);
      });
    });
  }

  // Expanding a group programmatically (used after a command is moved into a collapsed one -
  // landing a row somewhere invisible would make the move look like it did nothing).
  function rememberExpanded(groupName) {
    const set = readCollapsed();
    if (!set.delete(groupName)) return;
    writeCollapsed(set);
  }

  // --- Row "..." menus. They're <details>, so opening/closing is native; this only enforces
  // one-open-at-a-time and closes them on an outside click or Escape, the way a menu is expected
  // to behave. Delegated onto the container/document, so no re-wiring after a list swap.
  function closeAllMenus(except) {
    commandsList.querySelectorAll("details.cc-menu[open]").forEach((menu) => {
      if (menu !== except) menu.open = false;
    });
  }

  commandsList.addEventListener("click", (event) => {
    const groupToggleForm = event.target.closest("form[data-group-toggle]");
    if (groupToggleForm) {
      // The group master switch sits inside the group's <summary>, so clicking it would collapse
      // the group as well. Toggling the <details> and submitting the form are both default
      // actions of this one click, and there's no way to cancel only the first - so cancel both
      // and re-issue the submit ourselves. requestSubmit() fires the very submit event
      // wireToggleForm() listens for, and never re-fires a click, so this can't loop.
      const submitter = event.target.closest("button[type='submit']");
      if (submitter) {
        event.preventDefault();
        groupToggleForm.requestSubmit(submitter);
      }
      return;
    }
    const summary = event.target.closest("summary.cc-menu-summary");
    if (summary) {
      // The click hasn't toggled this <details> yet, so "currently closed" means "about to open"
      // - close every other menu now rather than after it has opened.
      const menu = summary.parentElement;
      if (!menu.open) closeAllMenus(menu);
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("details.cc-menu")) closeAllMenus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllMenus();
  });

  function wireEditButtons() {
    commandsList.querySelectorAll(".js-edit").forEach((button) => {
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
        // No group field to fill: a command's group is changed from the row's "..." menu or by
        // dragging it, never by loading it into this form (routes/customCommands.js carries the
        // stored value over on save for exactly that reason).
        closeAllMenus();

        let overrides = [];
        try {
          overrides = JSON.parse(button.dataset.categoryTexts || "[]");
        } catch {
          overrides = [];
        }
        fillCategoryRows(overrides);

        heading.textContent = `${originalHeading} — !${button.dataset.name}`;
        updateConflict();

        snapshotFormState();
        modal.showModal();
        result.focus();
      });
    });
  }

  // --- Swapping in a freshly server-rendered list. Shared by every mutation that changes the
  // list's shape (create/edit, delete, move) - the server re-derives the whole grouped list
  // (routes/customCommands.js's listResponse) rather than the client patching rows around,
  // because which section a command belongs in is server-side logic.
  // `moved` names the command to land a jelly bounce on, so a drag or a menu-move visibly ends
  // somewhere instead of the list silently rearranging itself.
  function applyListHtml(data, moved) {
    commandsList.innerHTML = data.html;
    allCommands = data.commandsData || allCommands;
    applyCollapsedState();
    wireCommandsList();
    if (moved) bounceRow(moved);
  }

  function bounceRow(command) {
    const row = commandsList.querySelector(`.cc-row[data-command="${CSS.escape(command)}"]`);
    if (!row) return; // its group is collapsed, or it was deleted - nothing to point at
    row.classList.add("cc-jelly-drop");
    row.addEventListener("animationend", () => row.classList.remove("cc-jelly-drop"), { once: true });
    const box = row.getBoundingClientRect();
    if (box.top < 64 || box.bottom > window.innerHeight) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // --- Row menu actions that hit the server (move to group, delete): same fetch-with-fallback
  // shape as the toggles and the save, differing only in that a successful response replaces the
  // whole list. Delete is destructive and not undoable, so it confirms first.
  function wireRowActionForms() {
    commandsList.querySelectorAll("form.js-row-action").forEach((actionForm) => {
      actionForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const commandName = actionForm.querySelector('input[name="name"]').value;
        const isDelete = actionForm.classList.contains("js-delete-form");
        if (isDelete && !window.confirm(`!${commandName}`)) return;

        const submitButton = actionForm.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        try {
          const response = await fetch(actionForm.getAttribute("action"), {
            method: "POST",
            body: new URLSearchParams(new FormData(actionForm)),
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const data = await response.json();
          if (!data.ok) throw new Error(data.error || "action_failed");

          // A command moved into a collapsed group has to make that group open again, or the
          // move looks like it did nothing at all.
          if (!isDelete) rememberExpanded(actionForm.querySelector('input[name="group"]').value.trim());
          applyListHtml(data, isDelete ? null : commandName);
          showToast(isDelete ? toastEl?.dataset.deletedText : toastEl?.dataset.savedText);
        } catch {
          // Fail-soft, same as every other handler here: fall back to the plain submit the button
          // would have done with JS disabled rather than swallowing the click.
          actionForm.submit();
        } finally {
          submitButton.disabled = false;
        }
      });
    });
  }

  // --- Drag and drop: pick a command row up and drop it on any group section to move it there
  // (the same "setGroup" request the menu's move form sends). Delegated onto #commands-list,
  // which survives every list swap, so these are attached exactly once.
  //
  // The <details> section as a whole is the drop target rather than its <ul>, so a COLLAPSED
  // group accepts drops too - its list isn't rendered at all in that state.
  let draggedCommand = null;
  let draggedFromGroup = null;
  // Whether the gesture started on a control inside the row (the enable switch, the "..." menu)
  // rather than on the row body. dragstart fires on the draggable <li> itself, so its target
  // can't tell us where the pointer actually went down - this has to be recorded beforehand.
  let dragBlocked = false;

  commandsList.addEventListener("pointerdown", (event) => {
    dragBlocked = !!event.target.closest("form, summary, .cc-menu-panel");
  });

  function clearDropTargets() {
    commandsList.querySelectorAll(".cc-group-dropzone").forEach((el) => el.classList.remove("cc-group-dropzone"));
  }

  commandsList.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".cc-row");
    if (!row || dragBlocked) {
      event.preventDefault();
      return;
    }
    draggedCommand = row.dataset.command;
    draggedFromGroup = row.dataset.group || "";
    event.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag at all unless some data is set.
    event.dataTransfer.setData("text/plain", draggedCommand);
    closeAllMenus();
    row.classList.add("cc-row-dragging");
  });

  commandsList.addEventListener("dragend", () => {
    commandsList.querySelectorAll(".cc-row-dragging").forEach((el) => el.classList.remove("cc-row-dragging"));
    clearDropTargets();
    draggedCommand = null;
    draggedFromGroup = null;
  });

  // The group currently under the pointer, or null if it isn't a legal target. Dropping a command
  // back into the group it already sits in is a no-op, so that section never lights up.
  function dropTargetFor(event) {
    if (!draggedCommand) return null;
    const section = event.target.closest("details.cc-group");
    if (!section || (section.dataset.group || "") === draggedFromGroup) return null;
    return section;
  }

  // Recomputing the highlight on every dragover (instead of pairing dragenter with dragleave)
  // sidesteps the classic dragleave-fires-for-every-child-element problem entirely.
  commandsList.addEventListener("dragover", (event) => {
    const section = dropTargetFor(event);
    if (!section) return; // no preventDefault -> the browser shows "can't drop here"
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!section.classList.contains("cc-group-dropzone")) {
      clearDropTargets();
      section.classList.add("cc-group-dropzone");
    }
  });

  // Dragging out of the list entirely (relatedTarget outside it) is the one case dragover can't
  // clean up after, since it simply stops firing.
  commandsList.addEventListener("dragleave", (event) => {
    if (!commandsList.contains(event.relatedTarget)) clearDropTargets();
  });

  commandsList.addEventListener("drop", async (event) => {
    const section = dropTargetFor(event);
    if (!section) return;
    event.preventDefault();
    const command = draggedCommand;
    const targetGroup = section.dataset.group || "";
    clearDropTargets();

    // Reuse the dropped row's own move form: it already carries the CSRF token and the action,
    // and it's the same request the menu sends - only the group value differs.
    const moveForm = commandsList.querySelector(`.cc-row[data-command="${CSS.escape(command)}"] form.js-row-action:not(.js-delete-form)`);
    if (!moveForm) return;

    const body = new URLSearchParams(new FormData(moveForm));
    body.set("group", targetGroup);
    try {
      const response = await fetch(moveForm.getAttribute("action"), {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "move_failed");
      rememberExpanded(targetGroup);
      applyListHtml(data, command);
      showToast(toastEl?.dataset.savedText);
    } catch {
      // Nothing was moved and nothing was repainted, so unlike the form handlers there's no
      // half-applied state to escape from - a full reload puts the list back in sync with the
      // server, whichever side actually failed.
      location.reload();
    }
  });

  // --- Enable/disable toggle(s): fetch instead of a full page POST-redirect-GET, so flipping a
  // switch doesn't reload the whole (possibly long) command list, reset scroll position, AND hide
  // the very slide animation the switch is supposed to show (the reload replaces the button with
  // one already in its new state, mid-transition or not). Both the per-command toggle
  // (data-command-toggle) and the per-group master switch (data-group-toggle) share this - shared
  // repaint helper so a group flip visually updates its own switch AND every member command's own
  // switch in one pass.
  function paintToggle(button, enabled) {
    const thumb = button.querySelector("span");
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("bg-purple-600", enabled);
    button.classList.toggle("bg-neutral-700", !enabled);
    thumb.classList.toggle("translate-x-4", enabled);
    thumb.classList.toggle("translate-x-1", !enabled);
  }

  // Shared submit handler for both toggle flavors: same fetch-with-fallback shape, only what
  // happens with a successful response differs (onSuccess).
  function wireToggleForm(toggleForm, onSuccess) {
    toggleForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = toggleForm.querySelector('button[type="submit"]');
      if (button.disabled) return;

      button.disabled = true;
      try {
        // toggleForm.action, not getAttribute("action"), would resolve to the hidden
        // <input name="action"> instead of the URL string - a named form control shadows
        // HTMLFormElement's own "action" IDL property. That silently 404'd on
        // "[object HTMLInputElement]" and fell through to the plain-submit fallback below
        // on every click, defeating the whole point of this handler.
        const response = await fetch(toggleForm.getAttribute("action"), {
          method: "POST",
          body: new URLSearchParams(new FormData(toggleForm)),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data = await response.json();
        onSuccess(button, data);
      } catch {
        // Fail-soft: nothing changed visually, so just fall back to the plain submit the button
        // would have done anyway with JS disabled - the mod's click isn't silently swallowed.
        toggleForm.submit();
        return;
      } finally {
        button.disabled = false;
      }
    });
  }

  function wireCommandToggles() {
    commandsList.querySelectorAll("form[data-command-toggle]").forEach((toggleForm) => {
      wireToggleForm(toggleForm, (button, data) => paintToggle(button, data.enabled));
    });
  }

  // The group header's master switch: one response flips every command in that group, so repaint
  // the master switch itself plus every individual command switch tagged with the same group
  // (data-command-toggle's own data-group, set in partials/customCommandRow.ejs) - otherwise each
  // row's own switch would sit stale until the next full page load.
  function wireGroupToggles() {
    commandsList.querySelectorAll("form[data-group-toggle]").forEach((toggleForm) => {
      wireToggleForm(toggleForm, (button, data) => {
        paintToggle(button, data.enabled);
        const memberGroup = toggleForm.dataset.group;
        commandsList.querySelectorAll(`form[data-command-toggle][data-group="${CSS.escape(memberGroup)}"] button[type="submit"]`)
          .forEach((memberButton) => paintToggle(memberButton, data.enabled));
      });
    });
  }

  function wireCommandsList() {
    wireEditButtons();
    wireRowActionForms();
    wireCommandToggles();
    wireGroupToggles();
  }

  // --- Save: fetch instead of a full page POST-redirect-GET, same rationale and fallback shape as
  // the toggles above - a create/edit shouldn't reload the whole page just to add one row. Unlike
  // the toggles, a successful save also needs to: refresh the alias-conflict snapshot (the new/
  // edited command wasn't in it), swap in the freshly server-rendered list (a new command, or one
  // that changed group, needs to land in the right section - see routes/customCommands.js's
  // buildCommandsView), and put the form back in "create" mode.
  async function submitCommandForm() {
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const response = await fetch(form.getAttribute("action"), {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || "save_failed");

      applyListHtml(data, null);
      modal.close();
      showToast(toastEl?.dataset.savedText);
    } catch {
      // Fail-soft: same reasoning as the toggle handlers - fall back to the plain submit the
      // button would have done anyway with JS disabled, landing on the classic redirect + the
      // server-rendered error banner (views/customCommands.ejs's #error block).
      form.submit();
      return;
    } finally {
      submitButton.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!validateName()) {
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
        aliasError.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }

    if (updateConflict()) {
      (conflict.hidden ? announceConflict : conflict).scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    submitCommandForm();
  });

  applyCollapsedState();
  wireCommandsList();
})();
