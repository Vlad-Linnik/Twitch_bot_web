// /<channel>/settings/custom-commands/commands - progressive enhancement only.
//
// Everything on this page works with JavaScript disabled: the form is a plain POST, the row menu
// and the group sections are <details> (so they open and collapse natively), delete / move-to-
// group / the enable-disable toggle are plain POSTs inside that menu, and the category-override
// rows fall back to a fixed <noscript> set (views/customCommands.ejs). This file adds on top -
// loading a row back into the form to edit it, warning about the timer+pin conflict before the
// server has to reject it, a delete confirmation, rendering the category-override rows one at a
// time instead of a fixed block of five, the alias chip-list, remembering which groups were
// collapsed, dragging a command from one group into another, checking each typed category against
// Twitch, greying out the announcement colour while "announce" is off, and sorting/searching the
// list (public/js/commandListOrder.js).
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

  // --- Category check: each typed category name is looked up on Twitch through our own endpoint
  // (routes/customCommands.js's category-lookup - the browser never talks to Twitch), once the
  // typing settles or the field loses focus. "Found" uses the bot's comparison (case-insensitive,
  // exact - lib/categoryLookup.js), so a green border means the bot really will pick this text
  // when the stream is in that category. The result only informs: nothing here blocks a save.
  const lookupUrl = categoryContainer.dataset.lookupUrl;
  const LOOKUP_DEBOUNCE_MS = 450;
  // key -> settled answer. Only definite answers are kept; "unavailable" is retried on next edit.
  const lookupAnswers = new Map();
  const lookupTimers = new WeakMap();
  const NEUTRAL_BORDER = ["border-neutral-800", "focus:border-purple-600"];
  const STATE_BORDER = { found: "border-green-600", notFound: "border-red-600" };

  const categoryLookupKey = (value) => String(value || "").trim().toLowerCase();

  function categoryParts(row) {
    return {
      input: row.querySelector('input[name="categoryName"]'),
      art: row.querySelector(".cc-category-art"),
      status: row.querySelector(".cc-category-status"),
    };
  }

  // state: "idle" (blank, typing, or checking), "found", "notFound", "unavailable".
  function paintCategoryState(row, state, answer) {
    const { input, art, status } = categoryParts(row);
    if (!input || !art || !status) return;
    const colored = STATE_BORDER[state];
    // The focus colour is dropped while a verdict is shown: otherwise the green/red would only
    // appear once the mod clicks away, and the check fires while they are still in the field.
    input.classList.remove(...Object.values(STATE_BORDER), ...NEUTRAL_BORDER);
    input.classList.add(...(colored ? [colored] : NEUTRAL_BORDER));
    input.setAttribute("aria-invalid", state === "notFound" ? "true" : "false");

    const artUrl = state === "found" && answer && answer.boxArtUrl;
    art.hidden = !artUrl;
    if (artUrl) art.src = artUrl;
    else art.removeAttribute("src");
    input.classList.toggle("pl-9", !!artUrl);
    input.title = state === "found" && answer ? answer.name : "";

    status.replaceChildren();
    status.classList.remove("text-green-500", "text-red-400", "text-neutral-500");
    if (state === "found" && answer && answer.name !== input.value.trim()) {
      // Same category, different spelling ("path of exile"): the bot matches it anyway, but the
      // canonical name is worth showing so nobody "fixes" a correct row.
      status.textContent = categoryContainer.dataset.msgFound.replace("%s", answer.name);
      status.classList.add("text-green-500");
    } else if (state === "notFound") {
      status.classList.add("text-red-400");
      status.append(categoryContainer.dataset.msgNotFound);
      const suggestions = (answer && answer.suggestions) || [];
      if (suggestions.length) {
        const line = document.createElement("span");
        line.className = "flex flex-wrap items-center gap-1.5 mt-1 text-neutral-500";
        line.append(categoryContainer.dataset.msgSuggest);
        suggestions.forEach((suggestion) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "px-2 py-0.5 rounded-full border border-neutral-700 bg-neutral-800 text-neutral-200 hover:border-purple-500 transition-colors";
          chip.textContent = suggestion;
          chip.addEventListener("click", () => {
            input.value = suggestion;
            // Through the normal input path, so the next blank row appears if this one is now
            // complete, and the replacement gets checked like anything typed.
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.focus();
          });
          line.append(chip);
        });
        status.append(line);
      }
    } else if (state === "unavailable") {
      status.textContent = categoryContainer.dataset.msgUnavailable;
      status.classList.add("text-neutral-500");
    }
    status.hidden = !status.childNodes.length;
  }

  async function checkCategoryRow(row) {
    clearTimeout(lookupTimers.get(row));
    const { input } = categoryParts(row);
    if (!input || !lookupUrl) return;
    const typed = input.value.trim();
    const key = categoryLookupKey(typed);
    if (!key) {
      paintCategoryState(row, "idle");
      return;
    }
    if (lookupAnswers.has(key)) {
      const answer = lookupAnswers.get(key);
      paintCategoryState(row, answer.status, answer);
      return;
    }
    let answer;
    try {
      const response = await fetch(`${lookupUrl}?name=${encodeURIComponent(typed)}`, {
        headers: { Accept: "application/json" },
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.ok && (data.status === "found" || data.status === "notFound")) {
        answer = data;
        lookupAnswers.set(key, answer);
      } else if (response.status === 400) {
        answer = { status: "idle" };
      } else {
        answer = { status: "unavailable" };
      }
    } catch {
      answer = { status: "unavailable" };
    }
    // The mod may have kept typing while this was in flight; a verdict about an older value
    // must not land on the newer one.
    if (categoryLookupKey(input.value) !== key) return;
    paintCategoryState(row, answer.status, answer);
  }

  categoryContainer.addEventListener("input", (event) => {
    if (event.target.name !== "categoryName") return;
    const row = event.target.closest(".cc-category-row");
    if (!row) return;
    paintCategoryState(row, "idle");
    clearTimeout(lookupTimers.get(row));
    lookupTimers.set(row, setTimeout(() => checkCategoryRow(row), LOOKUP_DEBOUNCE_MS));
  });

  // Leaving the field checks at once instead of waiting out the debounce. `focusout` because
  // `blur` does not bubble to the container.
  categoryContainer.addEventListener("focusout", (event) => {
    if (event.target.name !== "categoryName") return;
    const row = event.target.closest(".cc-category-row");
    if (row) checkCategoryRow(row);
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
      // A stored row is checked the moment the command is opened for editing - a category that
      // was renamed on Twitch since it was saved shows up red here instead of silently never
      // matching on stream.
      checkCategoryRow(row);
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
    syncAnnounceColor();
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

  // --- The announcement colour is only usable while "announce" is ticked - the same gate the
  // per-category rows have behind their own checkbox. A disabled <select> is left out of the
  // submitted form, so a non-announcement saves with the default colour, which is what the server
  // falls back to anyway. Called from every place that changes `announce` programmatically
  // (form.reset, loading a row for editing), since those fire no change event.
  const announceColorField = document.getElementById("announceColorField");

  function syncAnnounceColor() {
    announceColor.disabled = !announce.checked;
    if (announceColorField) announceColorField.classList.toggle("opacity-40", !announce.checked);
  }

  announce.addEventListener("change", syncAnnounceColor);
  syncAnnounceColor();

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
        // While a search is typed, groups holding matches are opened by applyListView() - that is
        // the search showing its results, not the mod un-collapsing the group, so it must not be
        // remembered. Clearing the search puts the remembered state back.
        if (isSearchActive()) return;
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

  // --- Sort + search. The order and the matching live in public/js/commandListOrder.js (pure, and
  // unit-tested); this part only reads the rows into items and moves/hides the <li>s. Rows are
  // sorted inside their own group - which group a command is in is the mod's own organisation and
  // stays as the server rendered it. Re-applied after every list swap (applyListHtml), so a save
  // never undoes the chosen order or the typed query.
  //
  // Flipping a row's enable switch updates its data-enabled but does not re-sort on the spot: under
  // "enabled first" the row would jump away from the pointer that just clicked it. The new state
  // takes effect at the next sort, search or save.
  const Order = window.CommandListOrder || null;
  const listTools = document.getElementById("cc-list-tools");
  const searchInput = document.getElementById("cc-search");
  const sortSelect = document.getElementById("cc-sort");
  const searchEmpty = document.getElementById("cc-search-empty");
  const SORT_STORAGE_KEY = "cc-sort";
  const haystacks = new WeakMap(); // row -> search text; rows are new objects after each swap

  function isSearchActive() {
    return !!(Order && searchInput && Order.normalizeText(searchInput.value));
  }

  function readSortMode() {
    try {
      return Order.parseSortMode(localStorage.getItem(SORT_STORAGE_KEY));
    } catch {
      return Order.DEFAULT_SORT;
    }
  }

  function writeSortMode(mode) {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, mode);
    } catch {
      /* storage unavailable - the sort still applies, it just won't be remembered */
    }
  }

  // The search reads what the edit button already carries for loading the row into the form, so
  // there is one copy of each command's data in the markup, not two.
  function haystackFor(row) {
    let hay = haystacks.get(row);
    if (hay !== undefined) return hay;
    const edit = row.querySelector(".js-edit");
    let categoryTexts = [];
    try {
      categoryTexts = JSON.parse((edit && edit.dataset.categoryTexts) || "[]");
    } catch {
      categoryTexts = [];
    }
    hay = Order.buildHaystack({
      command: row.dataset.command,
      aliases: ((edit && edit.dataset.aliases) || "").split(",").map((a) => a.trim()).filter(Boolean),
      result: edit ? edit.dataset.result : "",
      categoryTexts,
    });
    haystacks.set(row, hay);
    return hay;
  }

  function applyListView() {
    if (!Order || !searchInput || !sortSelect) return;
    const mode = Order.parseSortMode(sortSelect.value);
    const query = searchInput.value;
    const searching = isSearchActive();
    const collapsed = searching ? null : readCollapsed();
    let rowsTotal = 0;
    let rowsShown = 0;

    commandsList.querySelectorAll("details.cc-group").forEach((section) => {
      const list = section.querySelector("ul");
      if (!list) return;
      const items = Array.from(list.children)
        .filter((row) => row.classList.contains("cc-row"))
        .map((row) => ({
          row,
          command: row.dataset.command,
          enabled: row.dataset.enabled === "1",
          createdAt: Number(row.dataset.created) || 0,
          uses: Number(row.dataset.uses) || 0,
        }));
      Order.sortCommands(items, mode).forEach((item) => list.appendChild(item.row));

      let shown = 0;
      items.forEach((item) => {
        const match = Order.matchesQuery(haystackFor(item.row), query);
        item.row.hidden = !match;
        if (match) shown += 1;
      });
      rowsTotal += items.length;
      rowsShown += shown;

      section.hidden = searching && shown === 0;
      const count = section.querySelector(".cc-group-count");
      if (count) count.textContent = searching ? `(${shown}/${items.length})` : `(${items.length})`;
      // A match inside a collapsed group would otherwise be found and still invisible.
      if (searching) {
        if (shown) section.open = true;
      } else {
        section.open = !collapsed.has(section.dataset.group);
      }
    });

    if (searchEmpty) searchEmpty.hidden = !(searching && rowsTotal > 0 && rowsShown === 0);
  }

  if (Order && listTools && searchInput && sortSelect) {
    sortSelect.value = readSortMode();
    listTools.hidden = false;
    searchInput.addEventListener("input", applyListView);
    sortSelect.addEventListener("change", () => {
      writeSortMode(Order.parseSortMode(sortSelect.value));
      applyListView();
    });
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
        syncAnnounceColor();

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
    applyListView();
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
        // The call-counter reset is not undoable either; its question comes from the server.
        if (actionForm.dataset.confirm && !window.confirm(actionForm.dataset.confirm)) return;

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
          const groupInput = actionForm.querySelector('input[name="group"]');
          if (groupInput) rememberExpanded(groupInput.value.trim());
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
    const moveForm = commandsList.querySelector(`.cc-row[data-command="${CSS.escape(command)}"] form.js-move-form`);
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

  // Keeps the row's data-enabled (what "enabled first" sorts on) in step with its switch.
  function markRowEnabled(insideRow, enabled) {
    const row = insideRow.closest(".cc-row");
    if (row) row.dataset.enabled = enabled ? "1" : "";
  }

  function wireCommandToggles() {
    commandsList.querySelectorAll("form[data-command-toggle]").forEach((toggleForm) => {
      wireToggleForm(toggleForm, (button, data) => {
        paintToggle(button, data.enabled);
        markRowEnabled(toggleForm, data.enabled);
      });
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
          .forEach((memberButton) => {
            paintToggle(memberButton, data.enabled);
            markRowEnabled(memberButton, data.enabled);
          });
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
  applyListView();
  wireCommandsList();
})();
