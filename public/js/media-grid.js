// Movie/game grid (views/mediaGrid.ejs): the filter form answers as it is used. Every keystroke in
// the search box (after a short pause), and every change of type, genre or sort, fetches the first
// portion of the new view from list.json and moves the grid into it with an animation: cards that
// stay glide to their new place, new ones grow in, the ones that left fade out where they stood.
//
// Without JS the form is a plain GET form (Enter submits, the button sits in <noscript>), so this
// file is an enhancement only. The URL is kept in step with history.replaceState, which is what
// makes a filtered view shareable and lets "back" from a card return to it.
//
// The grid element itself is replaced on every change rather than refilled: public/js/infinite-list.js
// binds its "show more" link and restore key once per list element, so a fresh element (with the
// list.json answer's listSrc and restoreKey) is the clean way to hand it the new view.
//
// Plain script sharing one global scope with every other page script: everything stays inside the IIFE.
(() => {
  const form = document.querySelector("form[data-media-filter]");
  if (!form || !window.fetch) return;

  const SEARCH_DELAY_MS = 160;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  const empty = document.querySelector("[data-media-empty]");
  const moreTemplate = document.querySelector("template[data-media-more-template]");
  const listPath = () => {
    const list = document.getElementById("media-grid");
    return list ? new URL(list.dataset.src, location.href).pathname : null;
  };

  let timer = null;
  let controller = null;

  // The form's values, without the empty ones - the same view list.json reads.
  function currentParams() {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) {
      if (typeof v === "string" && v.trim() !== "") params.set(k, v.trim());
    }
    return params;
  }

  // The tab links keep the current search and filters, as they do on a server-rendered page.
  function updateTabLinks(params) {
    for (const link of document.querySelectorAll("a[data-media-tab][href]")) {
      const url = new URL(link.href, location.href);
      if (url.pathname !== location.pathname) continue;
      for (const key of ["q", "type", "genre"]) {
        if (params.get(key)) url.searchParams.set(key, params.get(key));
        else url.searchParams.delete(key);
      }
      link.href = url.pathname + url.search;
    }
  }

  function rectsOf(list) {
    const rects = new Map();
    if (!list) return rects;
    for (const item of list.querySelectorAll("[data-list-item]")) {
      const r = item.getBoundingClientRect();
      // Only what can be seen is worth animating; far-off cards just appear in place.
      if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
      rects.set(item.dataset.listItem, { rect: r, el: item });
    }
    return rects;
  }

  // Cards that left the view fade out where they stood, as absolutely placed copies over the page.
  function ghostOut(before, keptIds) {
    for (const [id, { rect, el }] of before) {
      if (keptIds.has(id)) continue;
      const ghost = el.cloneNode(true);
      ghost.removeAttribute("data-list-item");
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${rect.left + window.scrollX}px`,
        top: `${rect.top + window.scrollY}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: "0",
        pointerEvents: "none",
        zIndex: "5",
      });
      document.body.appendChild(ghost);
      const anim = ghost.animate(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.85)" },
        ],
        { duration: 220, easing: "ease-in", fill: "forwards" }
      );
      anim.onfinish = () => ghost.remove();
      anim.oncancel = () => ghost.remove();
    }
  }

  function animateIn(list, before) {
    if (reduceMotion || !list.animate) return;
    const keptIds = new Set();
    let entering = 0;
    for (const item of list.querySelectorAll("[data-list-item]")) {
      const id = item.dataset.listItem;
      const was = before.get(id);
      const now = item.getBoundingClientRect();
      if (was) {
        keptIds.add(id);
        const dx = was.rect.left - now.left;
        const dy = was.rect.top - now.top;
        if (dx || dy) {
          item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
            duration: 380,
            easing: EASE,
          });
        }
      } else if (now.bottom > 0 && now.top < window.innerHeight) {
        item.animate(
          [
            { opacity: 0, transform: "translateY(12px) scale(0.92)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 320, delay: Math.min(entering, 12) * 25 + 80, easing: EASE, fill: "backwards" }
        );
        entering += 1;
      }
    }
    ghostOut(before, keptIds);
  }

  function setMoreLink(body) {
    for (const old of document.querySelectorAll("[data-media-more]")) old.remove();
    if (!body.nextCursor || !moreTemplate) return null;
    const wrapper = moreTemplate.content.firstElementChild.cloneNode(true);
    const url = new URL(body.pageHref, location.href);
    url.searchParams.set("cursor", body.nextCursor);
    wrapper.querySelector("a").href = url.pathname + url.search;
    return wrapper;
  }

  function render(body, params) {
    const oldList = document.getElementById("media-grid");
    const before = reduceMotion ? new Map() : rectsOf(oldList);

    const list = oldList.cloneNode(false);
    delete list.dataset.infiniteReady;
    list.removeAttribute("aria-busy");
    list.dataset.src = body.listSrc;
    list.dataset.restore = body.restoreKey;
    const template = document.createElement("template");
    template.innerHTML = body.html;
    list.appendChild(template.content);
    oldList.replaceWith(list);

    const more = setMoreLink(body);
    if (more) list.after(more);

    if (empty) {
      const filtered = params.has("q") || params.has("type") || params.has("genre");
      empty.textContent = filtered ? empty.dataset.emptySearch : empty.dataset.emptyTab;
      empty.hidden = body.total > 0;
    }

    history.replaceState(history.state, "", body.pageHref);
    updateTabLinks(params);
    if (window.InfiniteList) window.InfiniteList.init(list);
    animateIn(list, before);
  }

  async function refresh() {
    const path = listPath();
    if (!path) return;
    const params = currentParams();
    if (controller) controller.abort();
    controller = new AbortController();
    const grid = document.getElementById("media-grid");
    grid.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`${path}?${params}`, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = await response.json();
      if (!body.ok) throw new Error("not ok");
      render(body, params);
    } catch (err) {
      if (err.name === "AbortError") return;
      // A failed live update falls back to the plain form: the page reloads into the same view.
      form.submit();
    } finally {
      const current = document.getElementById("media-grid");
      if (current) current.removeAttribute("aria-busy");
    }
  }

  form.addEventListener("input", (event) => {
    if (event.target.name !== "q") return;
    clearTimeout(timer);
    timer = setTimeout(refresh, SEARCH_DELAY_MS);
  });
  form.addEventListener("change", (event) => {
    if (event.target.name === "q") return;
    clearTimeout(timer);
    refresh();
  });
  // Enter in the search box: answer at once instead of reloading the page.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(timer);
    refresh();
  });
})();
