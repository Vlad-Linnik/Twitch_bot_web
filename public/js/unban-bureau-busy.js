// views/unbanBureauBusy.ejs — the "a colleague is already at the desk" page.
//
// The shift is a lease with no push channel back to a turned-away moderator (db/
// unbanBureauShiftRepo.js), so this just retries the page itself: a reload either lands on the desk
// because the lease has ended, or re-renders this page. The busy branch of the route skips the
// queue read entirely, so a retry is two small queries.
//
// It gives up after MAX_ATTEMPTS. A tab left open on a colleague's day-long shift must not reload
// forever, and once the moderator has walked away the reload is pure noise - the button is still
// there when they come back.
//
// Loaded as a plain <script>, so everything is inside an IIFE: public/js/games/*.js and this file
// share one global scope, and a top-level declaration here could silently kill another page's
// script if the names ever collided.
(function () {
  "use strict";

  var RETRY_SECONDS = 15;
  var MAX_ATTEMPTS = 20; // ~5 minutes of waiting
  var ATTEMPT_KEY = "ub-busy-attempts:" + window.location.pathname;

  var status = document.getElementById("ub-busy-status");
  var retryButton = document.getElementById("ub-busy-retry");
  if (!status || !retryButton) return;

  var template = status.dataset.retryTemplate || "%s";
  var stoppedText = status.dataset.stopped || "";

  retryButton.addEventListener("click", function () {
    // An explicit retry is the moderator saying they're still here, so it resets the budget.
    try { window.sessionStorage.removeItem(ATTEMPT_KEY); } catch (err) { /* private mode */ }
    window.location.reload();
  });

  function readAttempts() {
    try { return parseInt(window.sessionStorage.getItem(ATTEMPT_KEY), 10) || 0; } catch (err) { return 0; }
  }

  var attempts = readAttempts();
  if (attempts >= MAX_ATTEMPTS) {
    status.textContent = stoppedText;
    return;
  }

  var remaining = RETRY_SECONDS;
  function render() { status.textContent = template.replace("%s", String(remaining)); }
  render();

  var timer = window.setInterval(function () {
    remaining -= 1;
    if (remaining > 0) { render(); return; }
    window.clearInterval(timer);
    try { window.sessionStorage.setItem(ATTEMPT_KEY, String(attempts + 1)); } catch (err) { /* private mode */ }
    window.location.reload();
  }, 1000);

  // A backgrounded tab throttles the interval to once a minute, which would leave a stale countdown
  // on screen; re-checking on focus keeps the number honest without a second timer.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && remaining > 0) render();
  });
})();
