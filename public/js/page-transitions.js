// Cross-document view transitions (public/css/input.css) apply a directional
// slide to every same-origin navigation by default. This adds two refinements
// on top, both progressive enhancement - a browser without the View
// Transition API (or with JS disabled) just keeps the CSS-only default.

const STORAGE_KEY = "pageTransitionType";

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest("a[href]");
  if (!link || link.target) return;

  // A page with a dirty form (settings-form.js) gets first say on any outgoing
  // link click - re-clicks itself via pendingLeaveAction once confirmed.
  if (window.hasUnsavedFormChanges?.()) {
    event.preventDefault();
    window.confirmLeaveUnsaved(() => link.click());
    return;
  }

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

// Ordered left-to-right position of the main nav links, used to pick a slide
// direction that matches which side of the nav bar the destination sits on.
const NAV_ORDER = ["/", "/commands", "/games", "/about"];

window.addEventListener("pagereveal", (event) => {
  // Consume the stash unconditionally: it was set for THIS navigation, so if
  // this one turns out to have no view transition at all it must not linger
  // and get picked up by some later, unrelated navigation.
  const stashed = sessionStorage.getItem(STORAGE_KEY);
  if (stashed) sessionStorage.removeItem(STORAGE_KEY);

  if (!event.viewTransition) return;

  if (stashed) {
    event.viewTransition.types.add(stashed);
    return;
  }

  const from = document.referrer ? new URL(document.referrer) : null;
  if (!from) return;

  // Same-pathname reload with no explicit transition marker (e.g. a settings
  // form's ?saved=1 redirect) - no transition, it's not a page change.
  if (from.pathname === location.pathname) {
    event.viewTransition.types.add("instant");
    return;
  }

  const fromIndex = NAV_ORDER.indexOf(from.pathname);
  const toIndex = NAV_ORDER.indexOf(location.pathname);
  if (fromIndex !== -1 && toIndex !== -1 && toIndex < fromIndex) {
    event.viewTransition.types.add("backward");
  }
  // toIndex > fromIndex, or either page unordered: falls through to the CSS
  // default (slide-in-from-right), so no type needs adding.
});
