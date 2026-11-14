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
  // Reordering the queue by dragging. While a row is held, state updates from the server are not
  // drawn into the queue (they would pull the row out from under the pointer); the latest one is
  // drawn on drop.
  let drag = null; // { row, id, startOrder, offsetY, pointerId }
  let queueRenderPending = false;
  let focusGripId = null; // the row whose handle keeps focus across a re-render (keyboard moves)

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

  // The channel's own playlist. Built once and redrawn inside, so the open/closed state of the
  // <details> survives every state update.
  const playlistCount = el("span");
  const autoBox = el("input", { type: "checkbox" });
  autoBox.addEventListener("change", () => command("autoPlaylist", { on: autoBox.checked }));
  const autoLabel = el("label", { class: "dm-check" }, autoBox, el("span", { text: t("playlistAuto") }));
  const autoHint = el("div", { class: "dm-hint", text: t("playlistAutoHint") });
  const playlistNote = el("div", { class: "dm-note is-warn" });
  const playlistBox = el("div", { class: "dm-list" });
  const playlistInput = el("input", { type: "text", placeholder: t("addPlaceholder"), autocomplete: "off", maxlength: "300" });
  const playlistMsg = el("div", { class: "dm-hint" });
  const playlistForm = el("form", { class: "dm-add" }, playlistInput, el("button", { class: "dm-btn", type: "submit", text: t("playlistAdd") }));
  playlistForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = playlistInput.value.trim();
    if (!url) return;
    command("playlistAdd", { url }, (result) => {
      playlistInput.classList.toggle("is-bad", !result.ok);
      playlistMsg.textContent = result.reason === "duplicate" ? t("playlistDuplicate") : result.reason === "full" ? t("playlistFull") : "";
      if (result.ok) playlistInput.value = "";
    });
  });
  playlistInput.addEventListener("input", () => {
    playlistInput.classList.remove("is-bad");
    playlistMsg.textContent = "";
  });
  const playlistDetails = el(
    "details",
    { class: "dm-playlist" },
    el("summary", { class: "dm-h" }, el("span", { text: t("playlist") }), playlistCount),
    playlistNote,
    playlistBox,
    playlistForm,
    playlistMsg
  );

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
    el("section", {}, autoLabel, autoHint, playlistDetails),
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
    if (item.platform === "playlist") {
      line.appendChild(el("span", { class: "dm-badge p-playlist", text: t("playlistBadge") }));
      return line;
    }
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
      const modes = [
        [null, t("coverNone")],
        ["hide", `🙈 ${t("coverHide")}`],
        ["blur", `🌫 ${t("coverBlur")}`],
        ["image", `🖼 ${t("coverImage")}`],
      ];
      card.appendChild(
        el(
          "div",
          { class: "dm-cover", title: t("coverHint") },
          el("span", { class: "dm-cover-label", text: t("coverLabel") }),
          ...modes.map(([mode, label]) =>
            el("button", {
              class: "dm-btn is-small" + ((state.cover || null) === mode ? " is-active" : "") + (mode ? " is-cover" : ""),
              type: "button",
              text: label,
              "aria-pressed": (state.cover || null) === mode ? "true" : "false",
              onclick: () => command("cover", { mode }),
            })
          )
        )
      );
    } else if (state.cover) {
      const names = { hide: t("coverHide"), blur: t("coverBlur"), image: t("coverImage") };
      card.appendChild(el("div", { class: "dm-cover" }, el("span", { class: "dm-cover-label", text: `${t("coverActive")} ${names[state.cover] || state.cover}` })));
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

  function row(item, { num, actions, extra, grip }) {
    const body = el("div", { class: "dm-row-body" }, donorLine(item), el("div", { class: "dm-title", text: titleOf(item), title: titleOf(item) }));
    if (item.message) body.appendChild(el("div", { class: "dm-msg-short", text: item.message, title: item.message }));
    if (extra) body.appendChild(extra);
    return el(
      "div",
      { class: "dm-row", "data-dm-id": String(item.id) },
      grip || null,
      num !== undefined ? el("span", { class: "dm-num", text: String(num) }) : null,
      el("a", { href: videoUrl(item), target: "_blank", rel: "noopener noreferrer", title: titleOf(item) }, thumb(item)),
      body,
      actions && actions.childNodes.length ? actions : null
    );
  }

  function renderQueue() {
    if (drag) {
      queueRenderPending = true;
      return;
    }
    queueRenderPending = false;
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
      const grip = canControl && state.queue.length > 1 ? makeGrip(item, index) : null;
      queueBox.appendChild(row(item, { num: index + 1, actions, grip }));
    });
    if (focusGripId !== null) {
      const grip = queueBox.querySelector(`.dm-row[data-dm-id="${focusGripId}"] .dm-grip`);
      if (grip) grip.focus();
      focusGripId = null;
    }
  }

  // --- drag to reorder ---------------------------------------------------------------------------
  // The row is moved in the DOM as the pointer passes a neighbour's middle, and follows the pointer
  // with a transform in between. On drop the server is told which item the row now stands in front
  // of (see MediaQueue.move) - the server's next "state" is what finally redraws the list.
  function queueRows() {
    return Array.from(queueBox.querySelectorAll(".dm-row[data-dm-id]"));
  }

  function rowId(rowEl) {
    return Number(rowEl.getAttribute("data-dm-id"));
  }

  function renumber() {
    queueRows().forEach((rowEl, i) => {
      const num = rowEl.querySelector(".dm-num");
      if (num) num.textContent = String(i + 1);
    });
  }

  function makeGrip(item, index) {
    const grip = el("span", {
      class: "dm-grip",
      text: "⠿",
      role: "button",
      tabindex: "0",
      title: t("dragHint"),
      "aria-label": t("dragHint"),
    });
    grip.addEventListener("pointerdown", (event) => startDrag(event, grip));
    grip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const queue = state.queue;
      let beforeId;
      if (event.key === "ArrowUp") {
        if (index === 0) return;
        beforeId = queue[index - 1].id;
      } else {
        if (index >= queue.length - 1) return;
        beforeId = index + 2 < queue.length ? queue[index + 2].id : null;
      }
      focusGripId = item.id;
      command("move", { id: item.id, beforeId, index: event.key === "ArrowUp" ? index - 1 : index + 1 });
    });
    return grip;
  }

  function startDrag(event, grip) {
    if (drag || event.button > 0) return;
    const rowEl = grip.closest(".dm-row");
    if (!rowEl) return;
    event.preventDefault();
    drag = {
      row: rowEl,
      id: rowId(rowEl),
      startOrder: queueRows().map(rowId).join(","),
      offsetY: event.clientY - rowEl.getBoundingClientRect().top,
      pointerId: event.pointerId,
    };
    rowEl.classList.add("is-dragging");
    queueBox.classList.add("is-sorting");
    // Listened for on the window, not captured on the handle: moving the row in the DOM detaches
    // the handle for an instant, which drops a pointer capture, and the release then never arrives.
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    placeDragged(event.clientY);
  }

  // Moves the held row to where the pointer is. Called on every move and once more on release:
  // a pointer may jump between two move events, and the release is the one position that counts.
  function placeDragged(y) {
    const others = queueRows().filter((r) => r !== drag.row);
    const next = others.find((r) => {
      const rect = r.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    if (next) {
      if (drag.row.nextElementSibling !== next) queueBox.insertBefore(drag.row, next);
    } else if (queueBox.lastElementChild !== drag.row) {
      queueBox.appendChild(drag.row);
    }
    renumber();
    drag.row.style.transform = "";
    const natural = drag.row.getBoundingClientRect().top;
    drag.row.style.transform = `translateY(${y - drag.offsetY - natural}px)`;

    // Near the window edge the page scrolls, so a long queue can be crossed in one drag.
    const edge = 48;
    if (y < edge) window.scrollBy(0, -12);
    else if (y > window.innerHeight - edge) window.scrollBy(0, 12);
  }

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);

    if (event.type === "pointerup") placeDragged(event.clientY);
    const { row: rowEl, id, startOrder } = drag;
    rowEl.style.transform = "";
    rowEl.classList.remove("is-dragging");
    queueBox.classList.remove("is-sorting");
    const rows = queueRows();
    const moved = event.type === "pointerup" && rows.map(rowId).join(",") !== startOrder;
    const nextRow = rowEl.nextElementSibling;
    drag = null;

    if (moved) {
      command("move", {
        id,
        beforeId: nextRow && nextRow.hasAttribute("data-dm-id") ? rowId(nextRow) : null,
        index: rows.indexOf(rowEl),
      });
    }
    // Cancelled or unmoved: put the list back as the server last described it. Moved: leave the
    // row where it was dropped - the server's answer to "move" redraws the list; the timer only
    // covers a move the server refused, which sends no answer at all.
    if (!moved) renderQueue();
    else setTimeout(() => {
      if (!drag) renderQueue();
    }, 1500);
  }

  function renderPlaylist() {
    const list = state.playlist || [];
    autoBox.checked = state.autoPlaylist === true;
    autoBox.disabled = !canControl;
    playlistCount.textContent = list.length ? String(list.length) : "";
    playlistForm.hidden = !canControl;
    playlistNote.textContent = state.playlistStalled ? t("playlistStalled") : "";
    playlistNote.hidden = !state.playlistStalled;
    const playingId = state.current && state.current.fromPlaylist ? state.current.playlistId : null;
    playlistBox.replaceChildren();
    if (list.length === 0) {
      playlistBox.appendChild(el("div", { class: "dm-empty", text: t("playlistEmpty") }));
      return;
    }
    for (const entry of list) {
      const actions = el("div", { class: "dm-row-actions" });
      if (canControl) {
        actions.appendChild(el("button", { class: "dm-btn is-small is-danger", type: "button", text: "✕", title: t("remove"), "aria-label": t("remove"), onclick: () => command("playlistRemove", { id: entry.id }) }));
      }
      const r = row({ id: entry.id, videoId: entry.videoId, title: entry.title, platform: "playlist" }, { actions });
      r.removeAttribute("data-dm-id");
      const badge = r.querySelector(".dm-donor-line");
      if (badge) badge.remove();
      if (entry.id === playingId) r.classList.add("is-playing");
      playlistBox.appendChild(r);
    }
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
    renderPlaylist();
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
