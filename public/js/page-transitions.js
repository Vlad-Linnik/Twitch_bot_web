// Cross-document view transitions (public/css/input.css) apply a directional
// slide to every same-origin navigation by default. This deferred script only
// WRITES the transition-type stash for the next navigation (click/submit
// listeners below); the READER - the pagereveal handler that applies the type
// on the incoming page - lives inline in views/partials/head.ejs, because a
// deferred script can lose the race against the first render on a slow
// connection and miss the pagereveal event entirely (the slide then fired
// with the wrong direction or not at all). STORAGE_KEY is duplicated there
// on purpose - keep the two in sync.

const STORAGE_KEY = "pageTransitionType";

// Shared-element morph for list -> detail navigations: home's channel cards
// (data-vt-name="stats-header"), the statistics page's Top Chatters/search rows
// (data-vt-name="user-header"), and the news feed's post cards (data-vt-name="post-card",
// on the <article> - an ancestor of the actual "comments" link that gets clicked, hence
// closest() rather than reading the clicked link's own dataset). Each name matches a static
// view-transition-name on the destination page (public/css/input.css). Only the ACTUAL
// clicked element may carry the name - giving every list row the same name at once is a
// duplicate the browser can't resolve and silently falls back to a plain fade - so it's
// applied here, on click, to that one element only. lastVtElement remembers it so a
// cancelled navigation (back button, etc.) followed by a click on a DIFFERENT row doesn't
// leave two elements sharing the name.
let lastVtElement = null;

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a[href]");
  if (!link || link.target) return;

  // Bug fix: clicking a nav link for the page you're already on still fires
  // a (pointless) navigation + transition. Prevent it outright - but only when
  // there's no fragment: an in-page "#section" anchor (e.g. the /commands
  // sidebar) has the same pathname/search as the current page by definition,
  // and must fall through to the browser's native scroll-to-anchor instead of
  // being swallowed here.
  if (link.pathname === location.pathname && link.search === location.search && !link.hash) {
    event.preventDefault();
    return;
  }

  // Links can opt into a specific transition: the language switcher wants a
  // fade instead of a slide, and "back to settings"/"back to home" links
  // outside the main nav (which NAV_ORDER below doesn't cover) always want
  // the backward (slide-in-from-left) treatment regardless of where they sit
  // relative to their destination. Stashed in sessionStorage rather than
  // read from the destination URL because middleware/i18n.js's ?lang=
  // handling redirects to a clean URL server-side, so a query param would
  // never reach the landed page for the fade case.
  const transition = link.dataset.transition;
  if (transition) sessionStorage.setItem(STORAGE_KEY, transition);

  if (lastVtElement) lastVtElement.style.viewTransitionName = "";
  const vtTarget = link.closest("[data-vt-name]");
  if (vtTarget) {
    vtTarget.style.viewTransitionName = vtTarget.dataset.vtName;
    lastVtElement = vtTarget;
  } else {
    lastVtElement = null;
  }
});

// Same opt-in for <form> submits (a plain click listener never sees these -
// the form, not the submit button, is what carries data-transition). Covers
// the various "Save" forms, which redirect back to the same page and should
// never show the directional slide.
document.addEventListener("submit", (event) => {
  const transition = event.target.dataset.transition;
  if (transition) sessionStorage.setItem(STORAGE_KEY, transition);
});

// The pagereveal handler that used to live here moved inline into
// views/partials/head.ejs - see the comment at the top of this file.
