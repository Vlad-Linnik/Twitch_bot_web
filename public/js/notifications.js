// The notifications bell in the nav bar (views/partials/nav.ejs) and the relative times on the
// /notifications page.
//
// The nav's markup is identical on every page, so the count and the list arrive here, from
// GET /notifications.json, after load. Every string in that answer - the replier's name, the item's
// title, the excerpt - is somebody's input: it goes into the page through textContent only, never
// innerHTML. Without JS the bell is a plain link to /notifications.
//
// A plain non-module script sharing one global scope with the others: everything stays inside the
// IIFE.
(function () {
  "use strict";

  const root = document.querySelector("[data-notif]");
  const lang = document.documentElement.lang || "en";

  // "5 min ago" in the page's language; falls back to the date when Intl can't.
  function relativeTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(seconds);
    try {
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
      if (abs < 60) return rtf.format(seconds, "second");
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
      if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
      if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day");
    } catch (_) {
      /* fall through to the date */
    }
    return date.toLocaleDateString(lang);
  }

  function fillTimes(scope) {
    for (const el of scope.querySelectorAll("time[data-notif-time]")) {
      const text = relativeTime(el.getAttribute("datetime"));
      if (text) {
        el.title = new Date(el.getAttribute("datetime")).toLocaleString(lang);
        el.textContent = text;
      }
    }
  }

  fillTimes(document);
  if (!root) return;

  const bell = root.querySelector("[data-notif-bell]");
  const badge = root.querySelector("[data-notif-badge]");
  const panel = root.querySelector("[data-notif-panel]");
  const csrf = root.getAttribute("data-csrf") || "";
  let data = null;
  let loading = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setBadge(text) {
    badge.textContent = text || "";
    badge.hidden = !text;
  }

  function load() {
    if (!loading) {
      loading = fetch("/notifications.json", { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (json && json.ok) {
            data = json;
            setBadge(json.badge);
            if (!panel.hidden) render();
          }
        })
        .catch(() => {})
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  function post(url) {
    const body = new URLSearchParams({ _csrf: csrf });
    return fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      body,
      keepalive: true,
    }).then((res) => (res.ok ? res.json() : null));
  }

  function openItem(item, event) {
    // A new tab / window keeps the browser's own behaviour; the notice is still marked read.
    const newTab = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey;
    if (newTab) {
      post(`/notifications/${encodeURIComponent(item.id)}/open`).catch(() => {});
      item.read = true;
      return;
    }
    event.preventDefault();
    post(`/notifications/${encodeURIComponent(item.id)}/open`)
      .catch(() => null)
      .then((json) => {
        window.location.href = (json && json.link) || item.href;
      });
  }

  function render() {
    panel.replaceChildren();
    if (!data) {
      panel.append(el("p", "px-4 py-3 text-neutral-500", "…"));
      return;
    }
    const labels = data.labels || {};

    const header = el("div", "flex items-center justify-between gap-2 px-4 py-2 border-b border-neutral-800");
    header.append(el("p", "font-medium text-neutral-100", labels.title));
    if (data.unread > 0) {
      const all = el("button", "text-xs text-purple-400 hover:text-purple-300", labels.markAllRead);
      all.type = "button";
      all.addEventListener("click", () => {
        all.disabled = true;
        post("/notifications/read-all")
          .catch(() => null)
          .then(() => {
            data.unread = 0;
            for (const item of data.items) item.read = true;
            setBadge("");
            render();
          });
      });
      header.append(all);
    }
    panel.append(header);

    if (!data.items.length) {
      panel.append(el("p", "px-4 py-4 text-neutral-500", labels.empty));
    } else {
      const list = el("ul", "max-h-96 overflow-y-auto py-1");
      for (const item of data.items) {
        const li = el("li");
        const a = el("a", `block px-4 py-2 hover:bg-neutral-800 ${item.read ? "" : "bg-purple-500/5"}`);
        a.href = item.href;
        const top = el("div", "flex items-start gap-2");
        const text = el("div", "min-w-0 flex-1");
        text.append(el("p", `truncate ${item.read ? "text-neutral-300" : "text-neutral-100 font-medium"}`, item.headline));
        text.append(el("p", "truncate text-xs text-neutral-500", item.where));
        if (item.excerpt) text.append(el("p", "mt-0.5 text-xs text-neutral-400 line-clamp-2 break-words", item.excerpt));
        const time = el("time", "block mt-0.5 text-[11px] text-neutral-600", relativeTime(item.createdAt));
        time.dateTime = item.createdAt;
        text.append(time);
        top.append(text);
        if (!item.read) {
          const dot = el("span", "mt-1.5 w-2 h-2 rounded-full bg-purple-500 shrink-0");
          dot.title = labels.unreadMark || "";
          top.append(dot);
        }
        a.append(top);
        a.addEventListener("click", (event) => openItem(item, event));
        a.addEventListener("auxclick", (event) => {
          if (event.button === 1) openItem(item, event);
        });
        li.append(a);
        list.append(li);
      }
      panel.append(list);
    }

    const footer = el("a", "block px-4 py-2 border-t border-neutral-800 text-center text-xs text-purple-400 hover:text-purple-300 hover:bg-neutral-800", labels.viewAll);
    footer.href = "/notifications";
    panel.append(footer);
  }

  function setOpen(open) {
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      load();
    }
  }

  bell.setAttribute("aria-haspopup", "true");
  bell.setAttribute("aria-expanded", "false");
  bell.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    setOpen(panel.hidden);
  });
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !root.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      bell.focus();
    }
  });
  // A reply that arrived while the tab sat in the background shows up when the viewer returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });

  load();
})();
