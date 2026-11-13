// Heart-toggle buttons (views/partials/newsCard.ejs, and every other channel section's cards) -
// POSTs to the button's own data-react-url and flips data-liked/the count optimistically, rolling
// back if the request fails. The URL is on the button rather than assembled here, so this file
// knows nothing about which section it is in. The two reaction types ("like"/"superlike") are independent toggles handled by
// the same code path - the button's own data-type decides which one a click affects.
//
// Logged-out visitors get the same clickable button (not disabled/greyed out) - a click sends
// them to /auth/login instead of reacting. csrfToken (data-csrf) is only ever set for a logged-in
// session (middleware/csrf.js's ensureToken), so its absence is the reliable "not logged in"
// signal - same convention every "Login with Twitch" link on the site uses. ?returnTo= is the
// current page (routes/authRoutes.js reads/sanitizes it, lib/returnTo.js) so login lands them
// back on this page instead of the home page.
//
// One delegated listener rather than one per button: the feed appends cards as the reader
// scrolls (public/js/infinite-list.js), and a button that arrives later must work the same.
(() => {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-react]");
    if (!button) return;
    if (button.dataset.busy === "1") return;

    const { reactUrl, type, csrf } = button.dataset;
    if (!csrf) {
      const returnTo = window.location.pathname + window.location.search;
      window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
      return;
    }
    const countEl = button.querySelector(".news-heart-count");
    const wasLiked = button.dataset.liked === "1";
    const prevCount = parseInt(countEl.textContent, 10) || 0;

    // Optimistic flip - most clicks succeed, and waiting for the round-trip on a heart button
    // reads as laggy for something this low-stakes.
    button.dataset.liked = wasLiked ? "0" : "1";
    button.setAttribute("aria-pressed", String(!wasLiked));
    countEl.textContent = String(prevCount + (wasLiked ? -1 : 1));
    button.dataset.busy = "1";

    try {
      const response = await fetch(reactUrl, {
        method: "POST",
        body: new URLSearchParams({ type, _csrf: csrf }),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = await response.json();
      // Reconcile with the server's actual count - covers any other viewer's reactions that
      // landed between this click and the response.
      button.dataset.liked = body.liked ? "1" : "0";
      button.setAttribute("aria-pressed", String(Boolean(body.liked)));
      countEl.textContent = String(body.count);
    } catch {
      // Roll back the optimistic flip - the click didn't actually register.
      button.dataset.liked = wasLiked ? "1" : "0";
      button.setAttribute("aria-pressed", String(wasLiked));
      countEl.textContent = String(prevCount);
    } finally {
      button.dataset.busy = "0";
    }
  });
})();
