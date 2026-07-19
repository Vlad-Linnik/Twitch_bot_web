// /games/durak's mode-select screen. The PC board (durak.js) and the
// multiplayer client (durak-multiplayer.js) both boot into hidden sections of
// the same page - this script just toggles which section is visible and, for
// "play with people", fires the event durak-multiplayer.js waits for before
// opening its WebSocket. A room deep link (dmp-root's data-auto-join-room-id,
// set server-side by routes/games.js's /games/durak/room/:roomId) skips the
// picker entirely and jumps straight into the people section.
(function () {
  "use strict";

  const modeSelectEl = document.getElementById("durak-mode-select");
  const pcSectionEl = document.getElementById("durak-pc-section");
  const peopleSectionEl = document.getElementById("durak-people-section");
  if (!modeSelectEl || !pcSectionEl || !peopleSectionEl) return;

  const pcBtn = document.getElementById("durak-mode-pc-btn");
  const peopleBtn = document.getElementById("durak-mode-people-btn");
  const backLink = document.getElementById("durak-back-to-modes");

  function showMode(mode) {
    modeSelectEl.hidden = mode !== null;
    pcSectionEl.hidden = mode !== "pc";
    peopleSectionEl.hidden = mode !== "people";
    if (backLink) backLink.hidden = mode === null;
  }

  pcBtn?.addEventListener("click", () => showMode("pc"));
  peopleBtn?.addEventListener("click", () => {
    showMode("people");
    document.dispatchEvent(new CustomEvent("durak:play-people"));
  });
  backLink?.addEventListener("click", (e) => {
    e.preventDefault();
    showMode(null);
  });

  const dmpRoot = document.getElementById("dmp-root");
  if (dmpRoot && dmpRoot.dataset.autoJoinRoomId) showMode("people");
})();
