// /<channel>/statistics/chat - channel word cloud, emote-image cloud, universal log search.
//
// Same shape as user-dashboard.js: vanilla + no charting library, boots from the data the server
// already inlined, and only a PERIOD CHANGE re-fetches. The channel clouds are the most expensive
// reads on the site (they aggregate across every chatter), so not re-requesting them on load is
// not a micro-optimisation - it halves the cost of a page view.
//
// The search markup only exists for moderators (the server gates it); every binding below
// null-checks, so the same script serves both audiences.
(function () {
  "use strict";

  const dataEl = document.getElementById("stats-chat-data");
  if (!dataEl) return;
  const boot = JSON.parse(dataEl.textContent);

  const $ = (id) => document.getElementById(id);
  const base = `/${encodeURIComponent(boot.channel)}`;
  // Top chatters is server-rendered all-time on first paint (see routes/statistics.js), so its
  // toggle starts at "all" regardless of the page-level cloud period.
  const periods = { wordcloud: boot.period, emotes: boot.period, search: boot.period, topchatters: "all" };

  // ---------------------------------------------------------------------------------------
  // Word cloud - sqrt scaling, so AREA rather than height tracks frequency (a word used 50x more
  // than another must not render 50x taller; it would blow the container and drown the rest).
  // ---------------------------------------------------------------------------------------
  const MIN_FONT = 13;
  const MAX_FONT = 52;

  function renderCloud(node, items) {
    if (!node) return;
    node.textContent = "";
    if (!items || items.length === 0) return;

    const max = Math.max(...items.map((i) => i.count), 1);
    const min = Math.min(...items.map((i) => i.count));
    const span = Math.sqrt(max) - Math.sqrt(min) || 1;

    items.forEach((item, index) => {
      const scale = (Math.sqrt(item.count) - Math.sqrt(min)) / span;
      const size = MIN_FONT + scale * (MAX_FONT - MIN_FONT);

      const word = document.createElement("span");
      word.textContent = item.word; // textContent, never innerHTML - this came from chat
      word.title = `${item.word} — ${item.count.toLocaleString()}`;
      word.style.fontSize = `${size.toFixed(1)}px`;
      word.style.lineHeight = "1.1";
      word.className =
        "font-medium cursor-default " +
        (scale > 0.66 ? "text-purple-300" : scale > 0.33 ? "text-neutral-300" : "text-neutral-500");

      word.style.opacity = "0";
      word.style.transition = "opacity 300ms ease";
      setTimeout(() => (word.style.opacity = "1"), Math.min(index * 8, 350));

      node.appendChild(word);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Emote cloud - real emote images (the server resolves imageUrl from the channel's 7TV set +
  // Twitch globals). sqrt scale so mid-list emotes stay legible instead of the leader dwarfing
  // everything. An emote with no image (removed from the set since it was counted) keeps its
  // text form rather than dropping history.
  // ---------------------------------------------------------------------------------------
  function renderEmoteCloud(payload) {
    const node = $("emote-cloud");
    const empty = $("emote-cloud-empty");
    if (!node) return;

    const emotes = payload.emotes || [];
    node.textContent = "";
    // An empty cloud is a real, explainable state (the channel has no tracked 7TV set and no
    // global-emote sync has run yet), not an error - say so rather than showing a blank box.
    if (empty) empty.hidden = emotes.length > 0;

    const max = Math.max(...emotes.map((e) => e.count), 1);

    emotes.forEach((emote) => {
      const size = Math.round(24 + Math.sqrt(emote.count / max) * 40);
      const title = `${emote.word} × ${emote.count.toLocaleString()}`;

      if (emote.imageUrl) {
        const img = document.createElement("img");
        img.src = emote.imageUrl;
        img.alt = emote.word;
        img.title = title;
        img.loading = "lazy";
        img.style.height = `${size}px`;
        img.className = "w-auto inline-block hover:scale-110 transition-transform";
        node.appendChild(img);
      } else {
        const span = document.createElement("span");
        span.textContent = emote.word; // chat-derived - textContent only
        span.title = title;
        span.style.fontSize = `${Math.max(12, Math.round(size * 0.45))}px`;
        span.className = "text-neutral-400 font-medium";
        node.appendChild(span);
      }
    });
  }

  // ---------------------------------------------------------------------------------------
  // Top chatters - rebuilt on period change, mirroring the exact markup statisticsChat.ejs
  // renders on first paint (same classes) so a toggled list is indistinguishable from a fresh
  // page load. Names come from chat - textContent only, never innerHTML.
  // ---------------------------------------------------------------------------------------
  function renderTopChatters(payload) {
    const node = $("top-chatters");
    if (!node) return;
    node.textContent = "";

    const chatters = payload.chatters || [];
    if (chatters.length === 0) {
      const li = document.createElement("li");
      li.className = "px-4 py-6 text-center text-neutral-600 text-sm";
      li.textContent = node.dataset.emptyText || "";
      node.appendChild(li);
      return;
    }

    chatters.forEach((u) => {
      const medal = u.rank === 1 ? "👑" : u.rank === 2 ? "🥈" : u.rank === 3 ? "🥉" : null;

      const li = document.createElement("li");
      li.className = "flex items-center gap-3 px-4 py-2.5";

      const rank = document.createElement("span");
      rank.className =
        "w-6 shrink-0 text-center " + (medal ? "text-base" : "text-xs text-neutral-600 tabular-nums");
      rank.textContent = medal || String(u.rank);

      const name = document.createElement("a");
      name.href = `${base}/user/${encodeURIComponent(u.userName)}`;
      name.className =
        "hover:underline truncate flex-1 min-w-0" +
        (u.rank <= 3 ? " font-medium" : "") +
        (u.color ? "" : " text-neutral-200");
      if (u.color) name.style.color = u.color;
      name.textContent = u.userName;

      const count = document.createElement("span");
      count.className = "text-neutral-500 text-sm tabular-nums shrink-0";
      count.textContent = Number(u.messageCount).toLocaleString();

      li.append(rank, name, count);
      node.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Period toggles
  // ---------------------------------------------------------------------------------------
  async function refresh(component, period) {
    periods[component] = period;
    if (component === "search") return runSearch();

    const res = await fetch(`${base}/stats.json?component=${component}&period=${period}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const data = await res.json();

    if (component === "wordcloud") renderCloud($("channel-word-cloud"), data.words);
    if (component === "emotes") renderEmoteCloud(data);
    if (component === "topchatters") renderTopChatters(data);
  }

  document.querySelectorAll("[data-period-toggle]").forEach((group) => {
    const component = group.dataset.periodToggle;
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-period]");
      if (!button) return;

      group.querySelectorAll("button").forEach((b) => {
        const active = b === button;
        b.setAttribute("aria-pressed", String(active));
        b.className =
          "px-2 py-1 text-xs rounded transition-colors " +
          (active ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300");
      });

      refresh(component, button.dataset.period);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Universal log search
  //
  // Naming users in the filter does not merely narrow the RESULTS - it narrows the index range
  // the query runs over, which is what makes fuzzy matching affordable at all. So the UI nudges
  // toward naming users, and reports honestly when fuzzy had to be declined.
  // ---------------------------------------------------------------------------------------
  const termInput = $("search-term");
  const usersInput = $("search-users");
  const fuzzyInput = $("search-fuzzy");
  const results = $("search-results");
  const status = $("search-status");

  let timer = null;
  let seq = 0;

  async function runSearch() {
    if (!results) return;

    const term = termInput ? termInput.value.trim() : "";
    const users = usersInput ? usersInput.value.trim() : "";
    const fuzzy = fuzzyInput && fuzzyInput.checked ? "1" : "0";

    // Don't fire a channel-wide, unfiltered scan just because the page loaded.
    if (!term && !users) {
      results.textContent = "";
      status.textContent = "";
      return;
    }

    const mine = ++seq;
    status.textContent = "…";

    const url =
      `${base}/search.json?q=${encodeURIComponent(term)}` +
      `&users=${encodeURIComponent(users)}&period=${periods.search}&fuzzy=${fuzzy}`;

    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (mine !== seq) return; // a newer keystroke already superseded this response

    if (!res.ok) {
      results.textContent = "";
      status.textContent = res.status === 401 || res.status === 403 ? "⛔" : "error";
      return;
    }

    const data = await res.json();
    if (mine !== seq) return;

    results.textContent = "";
    for (const row of data.results) {
      const li = document.createElement("li");
      li.className = "px-4 py-2 flex gap-3 items-baseline";

      const time = document.createElement("span");
      time.className = "text-neutral-600 text-xs shrink-0 tabular-nums";
      time.textContent = new Date(row.timestamp).toLocaleString();

      const who = document.createElement("a");
      who.className = "text-purple-400 hover:text-purple-300 shrink-0 text-xs font-medium";
      who.href = `${base}/user/${encodeURIComponent(row.userName)}`;
      who.textContent = row.userName;

      const msg = document.createElement("span");
      msg.className = "text-neutral-300 break-words min-w-0";
      msg.textContent = row.message; // attacker-controlled - textContent only

      li.append(time, who, msg);
      results.appendChild(li);
    }

    const parts = [`${data.results.length}${data.truncated ? "+" : ""}`];
    if (data.unresolved && data.unresolved.length) {
      parts.push(`unknown: ${data.unresolved.join(", ")}`);
    }
    if (data.fuzzyRefusedReason === "too_many_candidates") {
      // Say why, and say what to do about it. Silently downgrading to exact search would look
      // like fuzzy simply not working.
      parts.push(`fuzzy off — ${data.candidateCount.toLocaleString()} candidates, add users or shorten the range`);
    } else if (data.fuzzyApplied) {
      parts.push("fuzzy");
    }
    status.textContent = parts.join(" · ");
  }

  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  };

  if (termInput) termInput.addEventListener("input", debounced);
  if (usersInput) usersInput.addEventListener("input", debounced);
  if (fuzzyInput) fuzzyInput.addEventListener("change", runSearch);

  // ---------------------------------------------------------------------------------------
  // First paint, from the inlined server data.
  // ---------------------------------------------------------------------------------------
  renderCloud($("channel-word-cloud"), boot.wordCloud.words);
  renderEmoteCloud(boot.emoteCloud);
})();
