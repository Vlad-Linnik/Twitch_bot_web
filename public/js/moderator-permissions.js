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

// Tooltip for the section headers and boxes: what exactly ticking that box allows. The native
// `title` appears only after a delay, never on touch, and holds one line, so it is replaced by one
// floating element filled from the page's <template data-perm-tip-content>. It is position:fixed
// on <body> because the table sits in an overflow-x container that would clip anything absolute.
(() => {
  const triggers = document.querySelectorAll("[data-perm-tip]");
  if (triggers.length === 0) return;

  const tip = document.createElement("div");
  tip.className = "perm-tip";
  tip.id = "perm-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);

  const GAP = 8;
  let current = null;

  const show = (trigger) => {
    const source = document.querySelector(`template[data-perm-tip-content="${trigger.dataset.permTip}"]`);
    if (!source) return;
    if (current !== trigger) tip.replaceChildren(source.content.cloneNode(true));
    current = trigger;
    tip.hidden = false;

    const rect = trigger.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - box.width - GAP));
    let top = rect.bottom + GAP;
    if (top + box.height > window.innerHeight - GAP) top = Math.max(GAP, rect.top - box.height - GAP);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    tip.hidden = true;
    current = null;
  };

  triggers.forEach((trigger) => {
    trigger.removeAttribute("title");
    trigger.setAttribute("aria-describedby", "perm-tip");
    trigger.addEventListener("mouseenter", () => show(trigger));
    trigger.addEventListener("mouseleave", hide);
    trigger.addEventListener("focusin", () => show(trigger));
    trigger.addEventListener("focusout", hide);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("scroll", hide, { passive: true });
})();
