// Heart-toggle buttons on the news feed (views/partials/newsCard.ejs) - POSTs to
// /:channel/news/:id/react and flips data-liked/the count optimistically, rolling back if the
// request fails. The two reaction types ("like"/"superlike") are independent toggles handled by
// the same code path - the button's own data-type decides which one a click affects.
(() => {
  for (const button of document.querySelectorAll("[data-news-react]")) {
    button.addEventListener("click", async () => {
      if (button.disabled || button.dataset.busy === "1") return;

      const { postId, channel, type, csrf } = button.dataset;
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
