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

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a[href]");
  if (!link || link.target) return;

  // Bug fix: clicking a nav link for the page you're already on still fires
  // a (pointless) navigation + transition. Prevent it outright.
  if (link.pathname === location.pathname && link.search === location.search) {
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
