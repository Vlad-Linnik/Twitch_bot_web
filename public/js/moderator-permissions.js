// The moderators page (views/channelModeratorPermissions.ejs): every box change saves the whole
// form with Accept: application/json, and the boxes are then set from the server's answer - what
// is on screen is what is stored, not what was clicked. A failed save puts the boxes back to the
// last state the server confirmed. Without JS the page's Save button posts the same form.
//
// Same request discipline as autosave.js: one request in flight, changes made meanwhile cause
// exactly one more save once it settles. The status pill is partials/autosaveStatus's.
(() => {
  const form = document.querySelector("form[data-mod-permissions]");
  if (!form) return;

  const SAVED_VISIBLE_MS = 2000;
  const status = form.querySelector("[data-autosave-status]");
  const boxes = () => form.querySelectorAll('input[type="checkbox"][data-section]');

  // name -> checked, as last confirmed by the server (the first paint is the server's too).
  let confirmed = new Map();
  const remember = () => {
    confirmed = new Map([...boxes()].map((box) => [box.name, box.checked]));
  };
  remember();

  let inFlight = false;
  let dirtyAgain = false;
  let savedTimer = null;

  const setStatus = (state, text) => {
    if (!status) return;
    status.classList.remove("is-saving", "is-saved", "is-error");
    if (state) status.classList.add(state);
    status.textContent = text || "";
  };

  // [{userId, allowed: {section: bool}}] -> the boxes.
  const applyServerState = (moderators) => {
    for (const { userId, allowed } of moderators || []) {
      for (const [section, value] of Object.entries(allowed || {})) {
        const box = form.querySelector(`input[name="${CSS.escape(`allow.${userId}.${section}`)}"]`);
        if (box) box.checked = Boolean(value);
      }
    }
  };

  const revert = () => {
    for (const box of boxes()) {
      if (confirmed.has(box.name)) box.checked = confirmed.get(box.name);
    }
  };

  const save = async () => {
    if (inFlight) {
      dirtyAgain = true;
      return;
    }
    inFlight = true;
    clearTimeout(savedTimer);
    setStatus("is-saving", status?.dataset.savingText);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { Accept: "application/json" },
      });
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (!body || !body.ok) throw new Error(`save failed: ${response.status}`);
      // A change made while this request was out is newer than its answer - keep it on screen and
      // let the follow-up save settle it.
      if (!dirtyAgain) applyServerState(body.moderators);
      remember();
      setStatus("is-saved", status?.dataset.savedText);
      savedTimer = setTimeout(() => setStatus(null, ""), SAVED_VISIBLE_MS);
    } catch {
      if (!dirtyAgain) revert();
      setStatus("is-error", status?.dataset.errorText);
    } finally {
      inFlight = false;
      if (dirtyAgain) {
        dirtyAgain = false;
        save();
      }
    }
  };

  form.addEventListener("change", (event) => {
    if (event.target.matches('input[type="checkbox"][data-section]')) save();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
})();
