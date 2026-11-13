// "ИИ-обзор для всех" on the Amnesty Bureau's settings page (views/channelUnbanBureauSettings.ejs).
//
// The job itself runs on the server (lib/unbanSummaryBatch.js); this script only asks how it is
// going, offers to start it with the numbers in front of the moderator, and stops it. Everything it
// draws comes from summaries/status.json, which is why a reload in the middle of a run simply shows
// the bar where it is: there is no client state worth losing.
//
// Polls every two seconds while a job runs and not at all otherwise - an idle settings tab should
// not keep counting a channel's queue forever.
(function () {
  "use strict";

  var root = document.getElementById("ub-batch");
  if (!root) return;

  var CHANNEL = root.dataset.channel;
  var CSRF = root.dataset.csrf || "";
  var T = JSON.parse(root.dataset.i18n || "{}");
  var BASE = "/" + encodeURIComponent(CHANNEL) + "/unban-bureau/summaries/";
  var POLL_MS = 2000;

  function $(id) { return document.getElementById(id); }
  function show(id, on) { $(id).hidden = !on; }

  // Same {{name}} substitution as config/i18n.js, for the few strings that carry numbers.
  function fmt(text, vars) {
    return String(text || "").replace(/\{\{(\w+)\}\}/g, function (m, name) {
      return name in vars ? String(vars[name]) : m;
    });
  }

  var last = null;
  var pollTimer = null;
  var busy = false;

  function request(method, path) {
    var opts = { method: method, headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (method === "POST") {
      // Form-encoded with the token in the body, like every other write on the site
      // (middleware/csrf.js reads req.body._csrf).
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.body = new URLSearchParams({ _csrf: CSRF });
    }
    return fetch(BASE + path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data || {} };
      });
    });
  }

  function message(text) {
    $("ub-batch-message").textContent = text || "";
    show("ub-batch-message", Boolean(text));
  }

  function renderErrors(job) {
    var list = $("ub-batch-errors-list");
    list.textContent = "";
    var errors = (job && job.errors) || [];
    show("ub-batch-errors", errors.length > 0 && job.status !== "running");
    if (!errors.length) return;
    $("ub-batch-errors-title").textContent = T.failedList;
    errors.forEach(function (e) {
      var li = document.createElement("li");
      li.textContent = (e.login || e.id) + " — " + e.reason;
      list.appendChild(li);
    });
  }

  function render(state) {
    last = state;
    var job = state.job;
    var running = Boolean(job && job.status === "running");

    $("ub-batch-open").disabled = busy || running || !state.available;
    show("ub-batch-stop", running);
    $("ub-batch-stop").disabled = Boolean(job && job.stopRequested);
    if (running) show("ub-batch-confirm", false);

    if (!state.available) {
      show("ub-batch-progress", false);
      message(T.unavailable);
      renderErrors(null);
      return;
    }

    if (job) {
      var pct = job.total ? Math.round((job.processed / job.total) * 100) : 0;
      show("ub-batch-progress", true);
      $("ub-batch-fill").style.width = pct + "%";
      $("ub-batch-bar").setAttribute("aria-valuenow", String(pct));
      $("ub-batch-label").textContent = fmt(T.running, { done: job.processed, total: job.total });
      $("ub-batch-current").textContent = running
        ? job.stopRequested
          ? T.stopping
          : job.current ? fmt(T.current, { login: job.current.login || job.current.id }) : ""
        : "";
      if (running) message("");
      else {
        message(fmt(job.status === "stopped" ? T.stopped : T.finished, {
          done: job.done, skipped: job.skipped, failed: job.failed,
        }));
      }
    } else {
      show("ub-batch-progress", false);
      message("");
    }
    renderErrors(job);
  }

  function schedule(running) {
    clearTimeout(pollTimer);
    if (running) pollTimer = setTimeout(refresh, POLL_MS);
  }

  function refresh() {
    return request("GET", "status.json").then(function (res) {
      if (res.status !== 200 || !res.data.ok) {
        schedule(Boolean(last && last.job && last.job.status === "running"));
        return;
      }
      render(res.data);
      schedule(Boolean(res.data.job && res.data.job.status === "running"));
    }).catch(function () {
      schedule(Boolean(last && last.job && last.job.status === "running"));
    });
  }

  // The confirmation is built from a FRESH count, not the one the page loaded with: the queue moves
  // while a settings tab sits open, and the number a moderator agrees to should be the real one.
  $("ub-batch-open").addEventListener("click", function () {
    if (busy) return;
    busy = true;
    $("ub-batch-open").disabled = true;
    request("GET", "status.json").then(function (res) {
      busy = false;
      if (res.status !== 200 || !res.data.ok) { message(T.error); render(last || { available: true }); return; }
      render(res.data);
      if (res.data.job && res.data.job.status === "running") { schedule(true); return; }
      var n = res.data.eligible || 0;
      if (!n) { message(T.nothing); return; }
      var minutes = Math.max(1, Math.ceil((n * (res.data.paceSec || 8)) / 60));
      $("ub-batch-confirm-text").textContent = fmt(T.confirm, { n: n, min: minutes });
      $("ub-batch-confirm-paid").textContent = res.data.paidFallback ? T.paid : "";
      show("ub-batch-confirm-paid", Boolean(res.data.paidFallback));
      message("");
      show("ub-batch-confirm", true);
    }).catch(function () {
      busy = false;
      message(T.error);
      if (last) render(last);
    });
  });

  $("ub-batch-cancel").addEventListener("click", function () {
    show("ub-batch-confirm", false);
  });

  $("ub-batch-start").addEventListener("click", function () {
    if (busy) return;
    busy = true;
    show("ub-batch-confirm", false);
    request("POST", "start.json").then(function (res) {
      busy = false;
      if (res.status === 200 && res.data.ok) return refresh();
      if (res.data.error === "nothing_to_do") message(T.nothing);
      else if (res.data.error === "generation_unavailable") message(T.unavailable);
      else if (res.data.error !== "already_running") message(T.error);
      return refresh();
    }).catch(function () {
      busy = false;
      message(T.error);
    });
  });

  $("ub-batch-stop").addEventListener("click", function () {
    $("ub-batch-stop").disabled = true;
    request("POST", "stop.json").then(refresh).catch(function () {
      $("ub-batch-stop").disabled = false;
      message(T.error);
    });
  });

  refresh();
})();
