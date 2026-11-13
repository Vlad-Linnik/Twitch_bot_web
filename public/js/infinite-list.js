// Load-on-scroll for server-rendered lists (the news feed now; the movie and game grids later).
//
// Markup contract:
//   <div id="X" data-infinite-list data-src="/<ch>/news/list.json" [data-restore="<key>"]>
//     <div data-list-item="<id>">...</div> ...
//   </div>
//   <a href="?cursor=..." data-infinite-more="X" data-loading-label=".." data-retry-label="..">
//
// The "show more" link is a real link to the next portion's HTML page, and it is the single
// place the next cursor lives. Without JS it is just followed; with JS this module fetches
// `data-src?cursor=` instead, appends the returned cards and moves the link's cursor on (or
// removes the link at the end). list.json renders the cards through the same partial as the
// first paint, so appended markup is identical to server-rendered markup.
//
// "Back" returns to the same card, not the same pixel offset: newer items may have been
// published above it since, and card heights depend on images. bfcache cannot be relied on for
// this - an open WebSocket, a beforeunload handler or Cache-Control: no-store on any later
// version of the page disables it, differently per browser, and the position would then be lost
// silently. So on leaving, the card under the click (or the top visible card) is written to
// sessionStorage; on a back/forward or reload load, the list is rebuilt down to that card with
// `?through=<id>` when it is not already rendered, and the page is scrolled to put it where it
// was. A page that does come out of bfcache (pageshow.persisted) is left alone - its DOM is
// already in place.
//
// Plain script sharing one global scope with every other page script: everything stays inside
// the IIFE, and the only global is window.InfiniteList.
(() => {
  // Start the next request this far before the link scrolls into view, so the reader rarely
  // reaches the end of what is loaded.
  const PREFETCH_MARGIN_PX = 800;
  const STORAGE_PREFIX = "infiniteList:";

  function readStore(key) {
    try {
      const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Private mode / storage full: losing the position is the only consequence.
    }
  }

  function navigationType() {
    const entry = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    return entry ? entry.type : "navigate";
  }

  function appendHtml(list, html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    list.appendChild(template.content);
  }

  function cursorFromLink(link) {
    return new URL(link.href, location.href).searchParams.get("cursor");
  }

  function init(list) {
    if (!list || list.dataset.infiniteReady === "1") return;
    list.dataset.infiniteReady = "1";

    let more = list.id ? document.querySelector(`[data-infinite-more="${CSS.escape(list.id)}"]`) : null;
    const moreLabel = more ? more.textContent.trim() : "";
    let busy = false;
    let failed = false;
    let observer = null;

    function setNext(nextCursor) {
      if (!more) return;
      if (!nextCursor) {
        if (observer) observer.disconnect();
        // The link's wrapper only exists to centre it.
        const wrapper = more.parentElement;
        more.remove();
        if (wrapper && wrapper.children.length === 0) wrapper.remove();
        more = null;
        return;
      }
      const url = new URL(more.href, location.href);
      url.searchParams.set("cursor", nextCursor);
      more.href = url.pathname + url.search;
    }

    function listUrl(params) {
      const url = new URL(list.dataset.src, location.href);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return url.pathname + url.search;
    }

    async function fetchJson(url) {
      const response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = await response.json();
      if (!body.ok) throw new Error(body.error || "not ok");
      return body;
    }

    // A short portion can leave the link inside the prefetch zone; IntersectionObserver only
    // reports changes, so it would never fire again on its own.
    function stillNearEnd() {
      if (!more) return false;
      return more.getBoundingClientRect().top < window.innerHeight + PREFETCH_MARGIN_PX;
    }

    async function loadNext() {
      if (busy || !more) return;
      const cursor = cursorFromLink(more);
      if (!cursor) return;
      busy = true;
      failed = false;
      list.setAttribute("aria-busy", "true");
      more.textContent = more.dataset.loadingLabel || moreLabel;
      try {
        const body = await fetchJson(listUrl({ cursor }));
        appendHtml(list, body.html);
        if (more) more.textContent = moreLabel;
        setNext(body.nextCursor);
      } catch {
        // Stop auto-loading; the link becomes a retry button the reader presses deliberately.
        failed = true;
        if (more) more.textContent = more.dataset.retryLabel || moreLabel;
      } finally {
        busy = false;
        list.removeAttribute("aria-busy");
      }
      if (!failed && stillNearEnd()) loadNext();
    }

    if (more) {
      more.addEventListener("click", (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        loadNext();
      });
      if ("IntersectionObserver" in window) {
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting) && !failed) loadNext();
          },
          { rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px` }
        );
        observer.observe(more);
      }
    }

    const restoreKey = list.dataset.restore;
    if (!restoreKey) return;

    // --- Saving the position ---------------------------------------------------------------
    let clickedAnchor = null;

    function anchorFor(item) {
      return { throughId: item.dataset.listItem, offset: Math.round(item.getBoundingClientRect().top) };
    }

    // The first card whose bottom edge is below the top of the viewport - the one the reader is
    // looking at when they leave without clicking a card (site nav, address bar).
    function topVisibleItem() {
      for (const item of list.querySelectorAll("[data-list-item]")) {
        if (item.getBoundingClientRect().bottom > 0) return item;
      }
      return null;
    }

    list.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      const item = event.target.closest("[data-list-item]");
      if (link && item) clickedAnchor = anchorFor(item);
    });

    window.addEventListener("pagehide", () => {
      let anchor = clickedAnchor;
      if (!anchor) {
        const item = topVisibleItem();
        // Still at the very top: nothing worth restoring, and a stale record must not survive.
        anchor = item && window.scrollY > 0 ? anchorFor(item) : null;
      }
      writeStore(restoreKey, anchor);
      clickedAnchor = null;
    });

    // --- Restoring it ----------------------------------------------------------------------
    // Our own restore replaces the browser's, which would put the old pixel offset onto a list
    // that may not have the same content (or length) any more.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    // This runs only on a real page load. A page restored from bfcache does not re-run scripts
    // at all - its DOM and scroll position never went anywhere - so it needs no check here.
    const type = navigationType();
    const saved = readStore(restoreKey);
    if (!saved || !saved.throughId || (type !== "back_forward" && type !== "reload")) return;

    function scrollToAnchor() {
      const item = list.querySelector(`[data-list-item="${CSS.escape(saved.throughId)}"]`);
      if (!item) return;
      // Negative is legitimate: a tall card whose top had scrolled above the viewport when its
      // bottom link was clicked. Only the upper bound is clamped, so the card stays on screen.
      const offset = Math.min(Number(saved.offset) || 0, window.innerHeight - 40);
      // "instant": the site sets scroll-behavior: smooth on <html>, which would otherwise animate
      // the jump from the top of the page down to the card on every return.
      window.scrollTo({ top: item.getBoundingClientRect().top + window.scrollY - offset, behavior: "instant" });
      const link = item.querySelector("a[href]");
      if (link) link.focus({ preventScroll: true });
    }

    // Scrolled synchronously, not in requestAnimationFrame: reading the card's position forces
    // layout anyway, and rAF does not run at all while the page is in a background tab - a
    // back navigation into a hidden tab would then never restore.
    if (list.querySelector(`[data-list-item="${CSS.escape(saved.throughId)}"]`)) {
      scrollToAnchor();
      return;
    }

    busy = true;
    list.setAttribute("aria-busy", "true");
    fetchJson(listUrl({ through: saved.throughId }))
      .then((body) => {
        if (!body.restored) return;
        list.replaceChildren();
        appendHtml(list, body.html);
        setNext(body.nextCursor);
        scrollToAnchor();
      })
      .catch(() => {
        // Keep the first portion that is already on the page.
      })
      .finally(() => {
        busy = false;
        list.removeAttribute("aria-busy");
        // The observer may have fired while this request held `busy`; it will not fire again
        // until the intersection changes.
        if (stillNearEnd()) loadNext();
      });
  }

  window.InfiniteList = { init };

  for (const list of document.querySelectorAll("[data-infinite-list]")) init(list);
})();
