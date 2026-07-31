// Heart-toggle buttons on the news feed (views/partials/newsCard.ejs) - POSTs to
// /:channel/news/:id/react and flips data-liked/the count optimistically, rolling back if the
// request fails. The two reaction types ("like"/"superlike") are independent toggles handled by
// the same code path - the button's own data-type decides which one a click affects.
//
// Logged-out visitors get the same clickable button (not disabled/greyed out) - a click sends
// them to /auth/login instead of reacting. csrfToken (data-csrf) is only ever set for a logged-in
// session (middleware/csrf.js's ensureToken), so its absence is the reliable "not logged in"
// signal - same convention every "Login with Twitch" link on the site uses. ?returnTo= is the
// current page (routes/authRoutes.js reads/sanitizes it, lib/returnTo.js) so login lands them
// back on this news feed instead of the home page.
(() => {
  for (const button of document.querySelectorAll("[data-news-react]")) {
    button.addEventListener("click", async () => {
      if (button.dataset.busy === "1") return;

      const { postId, channel, type, csrf } = button.dataset;
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
        const response = await fetch(`/${channel}/news/${postId}/react`, {
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
  }
})();
