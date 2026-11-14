// Donation media queue panel - the same script on the site (views/donationMediaQueue.ejs, a
// moderator logged in) and in the OBS dock (views/donationMediaObsPanel.ejs, the key from the
// link). The difference is only in how the socket authenticates (data-ws-query) and that the
// server says whether this viewer may control the queue ("access" message).
//
// The server (realtime/donationMediaManager.js) sends:
//   { type: "state", state }        everything - current, queue, history, statuses
//   { type: "progress", id, time, duration }
//   { type: "access", canControl }
//   { type: "reply", reqId, ok }    answer to "add"
// Every piece of donor-written text is put on the page as textContent, never as HTML.
(function () {
  "use strict";

  const root = document.getElementById("dm-panel");
  if (!root) return;

  const wsQuery = root.dataset.wsQuery || "";
  const locale = root.dataset.locale || "en";
  let i18n = {};
  try {
    i18n = JSON.parse(root.dataset.i18n || "{}");
  } catch (_) {
    i18n = {};
  }
  const t = (key) => (key in i18n ? i18n[key] : key);

  let ws = null;
  let reconnectAttempt = 0;
  let state = null;
  let progress = null; // { id, time, duration }
  let canControl = false;
  let reqSeq = 0;
  const pendingReplies = new Map();

  // --- the skeleton ------------------------------------------------------------------------------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else if (key === "style") node.style.cssText = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  const offline = el("div", { class: "dm-offline", text: t("offline") });
  const readOnlyNote = el("div", { class: "dm-note", text: t("readOnly") });
  readOnlyNote.hidden = true;
  const statusBox = el("div", { class: "dm-status" });
  const nowBox = el("div");
  const queueCount = el("span");
  const queueBox = el("div", { class: "dm-list" });
  const historyCount = el("span");
  const historyBox = el("div", { class: "dm-list" });

  const addInput = el("input", { type: "text", placeholder: t("addPlaceholder"), autocomplete: "off", maxlength: "300" });
  const addForm = el("form", { class: "dm-add" }, addInput, el("button", { class: "dm-btn", type: "submit", text: t("add") }));
  addForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = addInput.value.trim();
    if (!url) return;
    command("add", { url }, (result) => {
      addInput.classList.toggle("is-bad", !result.ok);
      if (result.ok) addInput.value = "";
    });
  });
  addInput.addEventListener("input", () => addInput.classList.remove("is-bad"));

  root.replaceChildren(
    offline,
    readOnlyNote,
    statusBox,
    el("section", {}, el("h2", { class: "dm-h" }, el("span", { text: t("nowPlaying") })), nowBox),
    el("section", {}, el("h2", { class: "dm-h" }, el("span", { text: t("queue") }), queueCount), queueBox, addForm),
    el("section", {}, el("h2", { class: "dm-h" }, el("span", { text: t("history") }), historyCount), historyBox)
  );

  // --- formatting --------------------------------------------------------------------------------
  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function formatAmount(amount) {
    if (!amount || !Number.isFinite(amount.value)) return "";
    if (amount.currency) {
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: amount.currency,
          maximumFractionDigits: Number.isInteger(amount.value) ? 0 : 2,
        }).format(amount.value);
      } catch (_) {
        return `${amount.value} ${amount.currency}`;
      }
    }
    return String(amount.value);
  }

  function platformName(platform) {
    return platform === "manual" ? t("manual") : platform;
  }

  function videoUrl(item) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}${item.start ? `&t=${Math.floor(item.start)}` : ""}`;
  }

  function thumb(item) {
    return el("div", {
      class: "dm-thumb",
      style: `background-image:url("https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg")`,
    });
  }

  // The line every row leads with: who paid, how much, through which platform.
  function donorLine(item) {
    const line = el("div", { class: "dm-donor-line" });
    if (item.platform === "manual") {
      line.appendChild(el("span", { class: "dm-donor is-anon", text: item.addedBy ? `${t("addedBy")} ${item.addedBy}` : t("manual") }));
    } else {
      line.appendChild(el("span", { class: "dm-donor" + (item.donor ? "" : " is-anon"), text: item.donor || t("anonymous") }));
    }
    const amount = formatAmount(item.amount);
    if (amount) line.appendChild(el("span", { class: "dm-amount", text: amount }));
    line.appendChild(el("span", { class: `dm-badge p-${item.platform}`, text: platformName(item.platform) }));
    if (item.replay) line.appendChild(el("span", { class: "dm-badge is-replay", text: t("replay") }));
    return line;
  }

  function titleOf(item) {
    return item.title || `YouTube · ${item.videoId}`;
  }

  // --- rendering ---------------------------------------------------------------------------------
  function renderStatus() {
    statusBox.replaceChildren();
    const add = (label, on, title) =>
      statusBox.appendChild(
        el("div", { class: "dm-status-item", title: title || null }, el("span", { class: "dm-dot" + (on ? " is-on" : "") }), el("span", { text: label }))
      );
    add(t("player"), state.playerConnected, state.playerConnected ? null : t("playerOff"));
    for (const [name, status] of Object.entries(state.platforms || {})) {
      add(name, status.connected, status.error || null);
    }
  }

  function renderNow() {
    nowBox.replaceChildren();
    const item = state.current;
    if (!item) {
      const text = state.queue.length > 0 && !state.playerConnected ? t("waitingForPlayer") : t("nothingPlaying");
      nowBox.appendChild(el("div", { class: "dm-empty", text }));
      return;
    }

    const info = el(
      "div",
      { class: "dm-now-info" },
      donorLine(item),
      el("div", { class: "dm-title" }, el("a", { href: videoUrl(item), target: "_blank", rel: "noopener noreferrer", text: titleOf(item) }))
    );
    if (item.message) info.appendChild(el("div", { class: "dm-message", text: item.message }));

    const bar = el("div", { class: "dm-bar" + (canControl ? " is-seekable" : ""), title: canControl ? t("seek") : null }, el("div", { class: "dm-bar-fill", id: "dm-bar-fill" }));
    if (canControl) {
      bar.addEventListener("click", (event) => {
        if (!progress || !progress.duration) return;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        command("seek", { time: ratio * progress.duration });
      });
    }

    const times = el(
      "div",
      { class: "dm-times" },
      el("span", { id: "dm-time-now", text: "0:00" }),
      el("span", { class: "dm-paused", text: state.paused ? t("paused") : "" }),
      el("span", { id: "dm-time-total", text: "—" })
    );

    const card = el("div", { class: "dm-now" }, el("div", { class: "dm-now-top" }, thumb(item), info), bar, times);
    if (canControl) {
      card.appendChild(
        el(
          "div",
          { class: "dm-controls" },
          state.paused
            ? el("button", { class: "dm-btn is-primary", type: "button", text: `▶ ${t("resume")}`, onclick: () => command("resume") })
            : el("button", { class: "dm-btn is-primary", type: "button", text: `⏸ ${t("pause")}`, onclick: () => command("pause") }),
          el("button", { class: "dm-btn is-danger", type: "button", text: `⏭ ${t("skip")}`, onclick: () => command("skip") }),
          el("button", { class: "dm-btn", type: "button", text: `↺ ${t("restart")}`, onclick: () => command("seek", { time: 0 }) })
        )
      );
    }
    nowBox.appendChild(card);
    renderProgress();
  }

  function renderProgress() {
    const fill = document.getElementById("dm-bar-fill");
    if (!fill || !state || !state.current) return;
    const active = progress && progress.id === state.current.id;
    const time = active ? progress.time : 0;
    const duration = active ? progress.duration : 0;
    fill.style.width = duration > 0 ? `${Math.min(100, (time / duration) * 100)}%` : "0";
    document.getElementById("dm-time-now").textContent = formatTime(time);
    document.getElementById("dm-time-total").textContent = duration > 0 ? formatTime(duration) : "—";
  }

  function row(item, { num, actions, extra }) {
    const body = el("div", { class: "dm-row-body" }, donorLine(item), el("div", { class: "dm-title", text: titleOf(item), title: titleOf(item) }));
    if (item.message) body.appendChild(el("div", { class: "dm-msg-short", text: item.message, title: item.message }));
    if (extra) body.appendChild(extra);
    return el(
      "div",
      { class: "dm-row" },
      num !== undefined ? el("span", { class: "dm-num", text: String(num) }) : null,
      el("a", { href: videoUrl(item), target: "_blank", rel: "noopener noreferrer", title: titleOf(item) }, thumb(item)),
      body,
      actions && actions.childNodes.length ? actions : null
    );
  }

  function renderQueue() {
    queueBox.replaceChildren();
    queueCount.textContent = state.queue.length ? String(state.queue.length) : "";
    if (state.queue.length === 0) {
      queueBox.appendChild(el("div", { class: "dm-empty", text: t("queueEmpty") }));
      return;
    }
    state.queue.forEach((item, index) => {
      const actions = el("div", { class: "dm-row-actions" });
      if (canControl) {
        if (index > 0) {
          actions.appendChild(el("button", { class: "dm-btn is-small", type: "button", text: "⤒", title: t("moveTop"), "aria-label": t("moveTop"), onclick: () => command("moveTop", { id: item.id }) }));
        }
        actions.appendChild(el("button", { class: "dm-btn is-small is-danger", type: "button", text: "✕", title: t("remove"), "aria-label": t("remove"), onclick: () => command("remove", { id: item.id }) }));
      }
      queueBox.appendChild(row(item, { num: index + 1, actions }));
    });
  }

  function renderHistory() {
    historyBox.replaceChildren();
    historyCount.replaceChildren();
    if (state.history.length) {
      historyCount.appendChild(document.createTextNode(String(state.history.length)));
      if (canControl) {
        historyCount.appendChild(document.createTextNode(" · "));
        historyCount.appendChild(el("button", { class: "dm-btn is-small", type: "button", text: t("clearHistory"), onclick: () => command("clearHistory") }));
      }
    }
    if (state.history.length === 0) {
      historyBox.appendChild(el("div", { class: "dm-empty", text: t("historyEmpty") }));
      return;
    }
    for (const item of state.history) {
      const statusText = t(`status.${item.status}`);
      const extra = statusText && item.status !== "played"
        ? el("div", { class: `dm-st s-${item.status}`, text: item.by ? `${statusText} · ${item.by}` : statusText })
        : null;
      const actions = el("div", { class: "dm-row-actions" });
      if (canControl) {
        actions.appendChild(el("button", { class: "dm-btn is-small", type: "button", text: `↻ ${t("requeue")}`, title: t("requeueHint"), onclick: () => command("replay", { id: item.id }) }));
        actions.appendChild(el("button", { class: "dm-btn is-small", type: "button", text: t("playNext"), title: t("playNextHint"), onclick: () => command("replay", { id: item.id, next: true }) }));
      }
      historyBox.appendChild(row(item, { actions, extra }));
    }
  }

  function render() {
    if (!state) return;
    readOnlyNote.hidden = canControl;
    addForm.hidden = !canControl;
    renderStatus();
    renderNow();
    renderQueue();
    renderHistory();
  }

  // --- the socket --------------------------------------------------------------------------------
  function command(type, payload, onReply) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !canControl) return;
    const message = Object.assign({ type }, payload || {});
    if (onReply) {
      message.reqId = ++reqSeq;
      pendingReplies.set(message.reqId, onReply);
    }
    ws.send(JSON.stringify(message));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/donation-media?${wsQuery}`);
    ws.addEventListener("open", () => {
      reconnectAttempt = 0;
      offline.classList.remove("is-shown");
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (msg.type === "state") {
        state = msg.state;
        if (state.current && state.progress) progress = Object.assign({ id: state.current.id }, state.progress);
        else if (!state.current) progress = null;
        render();
      } else if (msg.type === "progress") {
        progress = msg;
        renderProgress();
      } else if (msg.type === "access") {
        canControl = msg.canControl === true;
        render();
      } else if (msg.type === "reply") {
        const fn = pendingReplies.get(msg.reqId);
        pendingReplies.delete(msg.reqId);
        if (fn) fn(msg);
      }
    });
    ws.addEventListener("close", (event) => {
      offline.classList.add("is-shown");
      // 4001: the owner made new links - this one will never work again.
      if (event.code === 4001) {
        offline.textContent = t("keyReplaced");
        return;
      }
      reconnectAttempt++;
      setTimeout(connect, Math.min(1000 * Math.pow(2, reconnectAttempt), 15000));
    });
  }

  connect();
})();
