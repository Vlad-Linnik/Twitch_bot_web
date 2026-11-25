// The channel settings catalog panel (views/partials/settingsShellOpen.ejs): opens and closes the
// drawer, pins or unpins it on a wide screen, and folds its categories. The pin and the folded
// categories are cookies the server reads (middleware/settingsNav.js), so the next page is drawn with
// the panel already as it was left.
(() => {
  const shell = document.querySelector("[data-settings-shell]");
  if (!shell) return;

  const panel = document.getElementById("settings-nav");
  const backdrop = shell.querySelector(".settings-backdrop");
  const openButton = shell.querySelector("[data-settings-nav-open]");
  const pinButton = shell.querySelector("[data-settings-nav-pin]");
  const wide = window.matchMedia("(min-width: 1024px)");
  const YEAR_SECONDS = 365 * 24 * 60 * 60;

  const setCookie = (name, value) => {
    document.cookie = `${name}=${value}; path=/; max-age=${YEAR_SECONDS}; samesite=lax`;
  };
  const readCookie = (name) => {
    const pair = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return pair ? pair.slice(name.length + 1) : "";
  };

  const isPinnedOpen = () => wide.matches && shell.dataset.pinned === "1";

  const open = () => {
    if (isPinnedOpen()) return;
    shell.classList.add("is-open");
    backdrop.hidden = false;
    openButton?.setAttribute("aria-expanded", "true");
    // Into the panel, onto the page the visitor is on, so the keyboard starts where the eye does.
    // A page in a folded category cannot take focus; its heading can.
    (panel.querySelector('ul:not([hidden]) [aria-current="page"], .settings-nav-top[aria-current="page"]') ||
      panel.querySelector(".settings-nav-category.has-active") ||
      panel.querySelector("a, button"))?.focus({ preventScroll: true });
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
    setCookie(shell.dataset.pinCookie, pinned ? "1" : "0");
    // Pinning a drawer turns it into the column; unpinning puts the column away.
    close({ restoreFocus: false });
  });

  // Toggles one key in the cookie instead of writing down this page's headings: another tab may have
  // folded others since, and a category that is a plain link here may be a heading on another channel.
  shell.querySelectorAll("[data-settings-nav-category]").forEach((heading) => {
    heading.addEventListener("click", () => {
      const collapse = heading.getAttribute("aria-expanded") === "true";
      heading.setAttribute("aria-expanded", collapse ? "false" : "true");
      document.getElementById(heading.getAttribute("aria-controls")).hidden = collapse;

      const name = shell.dataset.collapsedCookie;
      const keys = new Set(readCookie(name).split(".").filter(Boolean));
      if (collapse) keys.add(heading.dataset.settingsNavCategory);
      else keys.delete(heading.dataset.settingsNavCategory);
      setCookie(name, [...keys].join("."));
    });
  });

  // Crossing the breakpoint with the drawer open would leave its backdrop over a pinned column.
  wide.addEventListener("change", () => close({ restoreFocus: false }));

  // Coming back through the history cache must not show a drawer left open on the way out.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) close({ restoreFocus: false });
  });
})();
