// The year recap's clips (views/annualRecap.ejs: clips of the year, loud moments): a player is built only when its
// thumbnail is clicked - six Twitch players on page load would be six heavy iframes nobody asked
// for. Without JS the thumbnail is simply a link to the clip on Twitch.
//
// A moderator's "remove" posts the same form the no-JS page sends, asks for JSON and takes the
// card out in place, so the page does not jump back to the top.
(function () {
  "use strict";

  // Any clip thumbnail on the page (the clips of the year and the loud moments) opens its player.
  document.addEventListener("click", function (event) {
    const link = event.target.closest("[data-clip-play]");
    if (!link) return;
    event.preventDefault();
    const holder = link.closest("[data-embed-parent]");
    const parent = (holder && holder.dataset.embedParent) || location.hostname;
    const slot = link.closest("[data-clip-slot]");
    const frame = document.createElement("iframe");
    frame.src =
      "https://clips.twitch.tv/embed?clip=" + encodeURIComponent(link.dataset.clipPlay) +
      "&parent=" + encodeURIComponent(parent) + "&autoplay=true";
    frame.allowFullscreen = true;
    frame.setAttribute("allow", "autoplay; fullscreen");
    frame.className = "absolute inset-0 h-full w-full";
    frame.title = link.textContent.trim();
    slot.replaceChildren(frame);
  });

  const list = document.querySelector("[data-recap-moments]");
  if (!list) return;

  list.addEventListener("submit", function (event) {
    const form = event.target.closest("[data-moment-hide]");
    if (!form) return;
    event.preventDefault();
    const card = form.closest("[data-moment]");
    fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: "same-origin",
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (data) {
        if (data && data.ok) card.remove();
        else form.submit();
      })
      .catch(function () { form.submit(); });
  });
})();
