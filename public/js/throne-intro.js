// Progressive enhancement for the throne theme's arrival curtain
// (views/partials/throneIntro.ejs). The curtain itself is pure CSS and clears on its own; this
// file only adds two behaviours that CSS cannot express:
//
//   1. Any deliberate action cuts it short. The intro plays on EVERY visit, so the tenth reload
//      of the day must not cost the reader 1.4 seconds they did not ask for.
//   2. It replays after a back/forward-cache restore. A restored page runs no animations again,
//      so without this the curtain would be missing exactly on the navigation people repeat most.
(function () {
  "use strict";

  const intro = document.getElementById("throne-intro");
  if (!intro) return;

  const SKIP_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
  let armed = false;

  function skip() {
    // Not a hard cut: jumping straight to the revealed page is more jarring than the animation
    // it replaces. The class shortens the remaining run to a fraction of its length.
    intro.classList.add("throne-intro--skipped");
    disarm();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    for (const type of SKIP_EVENTS) window.removeEventListener(type, skip);
  }

  function arm() {
    if (armed) return;
    armed = true;
    for (const type of SKIP_EVENTS) window.addEventListener(type, skip, { passive: true });
  }

  arm();
  // The curtain stays in the DOM once finished (it is two empty divs) rather than being removed,
  // so a bfcache restore has something to replay.
  intro.addEventListener("animationend", disarm);

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    intro.classList.remove("throne-intro--skipped");
    // Restarting a CSS animation needs the element out of the animation for one frame; toggling
    // the class alone is not enough because the style is never recomputed in between.
    intro.classList.add("throne-intro--reset");
    void intro.offsetWidth;
    intro.classList.remove("throne-intro--reset");
    arm();
  });
})();
