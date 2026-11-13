// The channel settings catalog panel (views/partials/settingsShellOpen.ejs): opens and closes the
// drawer, and pins or unpins it on a wide screen. The pin is a cookie the server reads
// (middleware/settingsNav.js), so the next page is drawn with the panel already where it was left.
(() => {
  const shell = document.querySelector("[data-settings-shell]");
  if (!shell) return;

  const panel = document.getElementById("settings-nav");
  const backdrop = shell.querySelector(".settings-backdrop");
  const openButton = shell.querySelector("[data-settings-nav-open]");
  const pinButton = shell.querySelector("[data-settings-nav-pin]");
  const wide = window.matchMedia("(min-width: 1024px)");
  const YEAR_SECONDS = 365 * 24 * 60 * 60;

  const isPinnedOpen = () => wide.matches && shell.dataset.pinned === "1";

  const open = () => {
    if (isPinnedOpen()) return;
    shell.classList.add("is-open");
    backdrop.hidden = false;
    openButton?.setAttribute("aria-expanded", "true");
    // Into the panel, onto the page the visitor is on, so the keyboard starts where the eye does.
    (panel.querySelector('[aria-current="page"]') || panel.querySelector("a, button"))?.focus({ preventScroll: true });
  };

  const close = ({ restoreFocus = true } = {}) => {
    if (!shell.classList.contains("is-open")) return;
    shell.classList.remove("is-open");
    backdrop.hidden = true;
    openButton?.setAttribute("aria-expanded", "false");
    if (restoreFocus && openButton && openButton.offsetParent !== null) openButton.focus({ preventScroll: true });
  };

  openButton?.addEventListener("click", open);
  shell.querySelectorAll("[data-settings-nav-close]").forEach((el) => el.addEventListener("click", () => close()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  pinButton?.addEventListener("click", () => {
    const pinned = shell.dataset.pinned !== "1";
    shell.dataset.pinned = pinned ? "1" : "0";
    pinButton.setAttribute("aria-pressed", pinned ? "true" : "false");
    document.cookie = `${shell.dataset.pinCookie}=${pinned ? "1" : "0"}; path=/; max-age=${YEAR_SECONDS}; samesite=lax`;
    // Pinning a drawer turns it into the column; unpinning puts the column away.
    close({ restoreFocus: false });
  });

  // Crossing the breakpoint with the drawer open would leave its backdrop over a pinned column.
  wide.addEventListener("change", () => close({ restoreFocus: false }));

  // Coming back through the history cache must not show a drawer left open on the way out.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) close({ restoreFocus: false });
  });
})();
