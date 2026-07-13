// Autosave for settings-type forms (form[data-autosave]) - replaces the old dirty-tracked
// Save buttons (settings-form.js / dirty-save.js). Progressive enhancement: with JS disabled
// the form's .save-fab submit button is visible (html.js never stamps) and the classic
// POST -> redirect path still works; with JS this script saves automatically and the button
// stays hidden (it is never given .save-visible).
//
// Save strategy per form:
//   - checkboxes/selects: save immediately on `change`;
//   - text/number/textarea: debounced while typing (`input`), plus a save on `change` (blur);
//   - every save serializes the WHOLE form (last-write-wins, same semantics as the old
//     Save button) and POSTs it urlencoded with `Accept: application/json` - the server
//     (routes/settings.js's respondSaved) answers {ok:true} instead of redirecting;
//   - one request in flight per form: changes landing mid-save set a flag and exactly one
//     re-save runs when the current request settles - never a queue;
//   - on pagehide, any pending debounce/dirty state is flushed with fetch keepalive, which
//     replaces the old unsaved-changes dialog (the response can't be read; worst case a
//     leave-in-the-same-instant edit fails silently, still strictly better than losing it).
//
// Status pill: [data-autosave-status] inside the form cycles .is-saving -> .is-saved
// (auto-clears) or .is-error (sticky until the next successful save). Localized texts ride
// on its data-* attributes so this script stays locale-free.
(() => {
  const DEBOUNCE_MS = 800;
  const SAVED_VISIBLE_MS = 2000;

  for (const form of document.querySelectorAll("form[data-autosave]")) {
    const status = form.querySelector("[data-autosave-status]");
    let debounceTimer = null;
    let savedTimer = null;
    let inFlight = false;
    let dirtyAgain = false;

    const setStatus = (state, text) => {
      if (!status) return;
      status.classList.remove("is-saving", "is-saved", "is-error");
      if (state) status.classList.add(state);
      status.textContent = text || "";
    };

    const showSaved = () => {
      setStatus("is-saved", status?.dataset.savedText);
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => setStatus(null, ""), SAVED_VISIBLE_MS);
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
        if (response.ok) {
          showSaved();
        } else {
          // A validation failure (400) carries a human-readable message; anything
          // else (403 csrf, 429 rate limit) falls back to the generic error text.
          let message = status?.dataset.errorText;
          try {
            const body = await response.json();
            if (body && typeof body.error === "string" && response.status === 400) message = body.error;
          } catch { /* non-JSON body - keep the generic text */ }
          setStatus("is-error", message);
        }
      } catch {
        // Network failure - the form still holds the user's values; the next change retries.
        setStatus("is-error", status?.dataset.errorText);
      } finally {
        inFlight = false;
        if (dirtyAgain) {
          dirtyAgain = false;
          save();
        }
      }
    };

    const scheduleSave = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        save();
      }, DEBOUNCE_MS);
    };

    form.addEventListener("input", (event) => {
      const el = event.target;
      if (el.matches('input[type="checkbox"], input[type="radio"], select')) return;
      scheduleSave();
    });

    form.addEventListener("change", () => {
      // A committed change (toggle click, blur after typing) saves without waiting
      // out the typing debounce.
      clearTimeout(debounceTimer);
      debounceTimer = null;
      save();
    });

    // Explicit submit still works (Enter key, or the no-JS button if CSS failed) -
    // route it through the same fetch path instead of a full-page POST.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearTimeout(debounceTimer);
      debounceTimer = null;
      save();
    });

    // Leaving the page with a save pending: fire it immediately, keepalive so the
    // browser lets it complete after the document goes away.
    window.addEventListener("pagehide", () => {
      if (!debounceTimer && !inFlight && !dirtyAgain) return;
      clearTimeout(debounceTimer);
      debounceTimer = null;
      try {
        fetch(form.action, {
          method: "POST",
          body: new URLSearchParams(new FormData(form)),
          headers: { Accept: "application/json" },
          keepalive: true,
        });
      } catch { /* nothing left to do - the page is going away */ }
    });
  }
})();
