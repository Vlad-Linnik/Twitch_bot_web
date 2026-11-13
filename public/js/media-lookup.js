// Search in outside sources on a movie card's form (views/mediaForm.ejs [data-lookup]).
//
// Typing searches the active tab (films: TMDB or the IMDb fallback; anime: Shikimori) through the
// section's lookup.json. Picking a result asks for its details and fills the plain form fields -
// title, original title, year, type, IMDb id, episode total - and ticks 18+ when the source says
// so (the editor can untick it). The pick itself travels as one hidden field, sourceRef; the
// server re-asks the source and downloads the poster from its own answer.
//
// Everything rendered from a result goes through textContent / attributes, never innerHTML:
// titles come from other people's databases.
//
// Plain script sharing the page's global scope: all of it stays inside the IIFE.
(() => {
  const root = document.querySelector("[data-lookup]");
  const form = document.querySelector("[data-media-form]");
  if (!root || !form) return;

  const input = root.querySelector("[data-lookup-input]");
  const status = root.querySelector("[data-lookup-status]");
  const list = root.querySelector("[data-lookup-results]");
  const tabs = [...root.querySelectorAll("[data-lookup-tab]")];
  const picked = root.querySelector("[data-lookup-picked]");
  const pickedImg = root.querySelector("[data-lookup-picked-img]");
  const pickedText = root.querySelector("[data-lookup-picked-text]");
  const refField = form.querySelector("[data-lookup-ref]");
  const url = root.dataset.lookupUrl;
  const DEBOUNCE_MS = 350;

  // The first tab the server drew is the default (films for movies, Twitch for games).
  let tab = tabs.length ? tabs[0].dataset.lookupTab : "films";
  let timer = null;
  let seq = 0;

  root.hidden = false;

  const setStatus = (text) => {
    status.textContent = text || "";
  };

  async function getJson(params) {
    const response = await fetch(`${url}?${new URLSearchParams(params)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.json();
  }

  function renderResults(results) {
    list.replaceChildren();
    for (const r of results) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "w-full flex items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-neutral-800/70 focus:bg-neutral-800/70 focus:outline-none";
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.className = "w-8 h-12 object-cover rounded bg-neutral-800 shrink-0";
      if (r.previewUrl) img.src = r.previewUrl;
      const text = document.createElement("span");
      text.className = "min-w-0";
      const title = document.createElement("span");
      title.className = "block text-sm text-neutral-100 truncate";
      title.textContent = r.title;
      const meta = document.createElement("span");
      meta.className = "block text-xs text-neutral-500 truncate";
      meta.textContent = [r.originalTitle, r.year].filter(Boolean).join(" · ");
      text.append(title, meta);
      button.append(img, text);
      button.addEventListener("click", () => pick(r));
      li.append(button);
      list.append(li);
    }
  }

  async function search() {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) {
      list.replaceChildren();
      setStatus("");
      return;
    }
    setStatus(root.dataset.msgLoading);
    try {
      const data = await getJson({ tab, q });
      if (mine !== seq) return; // a newer keystroke already asked
      renderResults(data.results || []);
      if (data.unavailable) setStatus(root.dataset.msgUnavailable);
      else setStatus(data.results && data.results.length ? "" : root.dataset.msgEmpty);
    } catch {
      if (mine === seq) setStatus(root.dataset.msgUnavailable);
    }
  }

  function setField(name, value) {
    const field = form.elements[name];
    if (!field || value === null || value === undefined || value === "") return;
    field.value = String(value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function pick(result) {
    setStatus(root.dataset.msgLoading);
    try {
      const data = await getJson({ ref: result.ref });
      const d = data.details;
      if (!d) throw new Error("no details");
      setField("title", d.title);
      if (form.elements.originalTitle) form.elements.originalTitle.value = d.originalTitle || "";
      setField("year", d.year);
      setField("mediaType", d.mediaType);
      setField("imdbId", d.imdbId);
      // Games: the Steam app and the Twitch category the pick belongs to.
      setField("steamAppId", d.external && d.external.steamAppId);
      setField("twitchCategoryName", d.external && d.external.twitchCategoryName);
      if (d.episodes && d.mediaType !== "film") setField("progressTotal", d.episodes);
      const nsfw = form.querySelector("[data-nsfw-checkbox]");
      if (nsfw && d.nsfwHint) nsfw.checked = true;
      refField.value = d.ref;

      const preview = d.posterUrl || result.previewUrl;
      pickedImg.hidden = !preview;
      if (preview) pickedImg.src = preview;
      pickedText.textContent = `${root.dataset.msgPicked} ${[d.title, d.year].filter(Boolean).join(", ")}`;
      picked.hidden = false;
      list.replaceChildren();
      setStatus("");
    } catch {
      setStatus(root.dataset.msgUnavailable);
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });
  // Enter in the search box searches; it must not submit the card form.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(timer);
      search();
    }
  });

  for (const button of tabs) {
    button.addEventListener("click", () => {
      tab = button.dataset.lookupTab;
      for (const b of tabs) b.setAttribute("aria-selected", String(b === button));
      search();
    });
  }

  root.querySelector("[data-lookup-clear]").addEventListener("click", () => {
    refField.value = "";
    picked.hidden = true;
    pickedImg.removeAttribute("src");
  });
})();
