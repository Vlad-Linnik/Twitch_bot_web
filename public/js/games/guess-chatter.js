// "Угадай чатера" (views/gameGuessChatter.ejs, routes/guessChatter.js).
//
// Unusually for this project, the client owns the game: start.json hands over all ten questions
// with their answers and the grading happens here. That is a consequence of there being no
// leaderboard - see the header of routes/guessChatter.js. The server is asked for exactly two more
// things: the context of one message, and a tick of the play counter at the end.
//
// Everything is inside one IIFE: public/js/games/*.js are plain non-module <script> tags sharing a
// single global scope, where a second file declaring the same top-level const silently kills
// whichever loads later.
(function () {
  "use strict";

  const dataNode = document.getElementById("gc-data");
  if (!dataNode) return;

  const DATA = JSON.parse(dataNode.textContent);
  const L = DATA.labels;
  const BEST_KEY = "guessChatterBest";

  // --- Elements ----------------------------------------------------------------

  const setupEl = document.getElementById("gc-setup");
  const playEl = document.getElementById("gc-play");
  const overEl = document.getElementById("gc-over");

  const channelsEl = document.getElementById("gc-channels");
  const playBtn = document.getElementById("gc-play-btn");
  const setupError = document.getElementById("gc-setup-error");

  const progressEl = document.getElementById("gc-progress");
  const scoreEl = document.getElementById("gc-score");
  const messageEl = document.getElementById("gc-message");
  const whenEl = document.getElementById("gc-when");
  const hintsEl = document.getElementById("gc-hints");
  const contextBtn = document.getElementById("gc-context-btn");
  const contextEl = document.getElementById("gc-context");
  const optionsEl = document.getElementById("gc-options");

  const overScoreEl = document.getElementById("gc-over-score");
  const overUnaidedEl = document.getElementById("gc-over-unaided");
  const overBestEl = document.getElementById("gc-over-best");
  const breakdownEl = document.getElementById("gc-breakdown");
  const againBtn = document.getElementById("gc-again");
  const understoodBtn = document.getElementById("gc-understood");

  // --- State -------------------------------------------------------------------

  let channel = channelsEl ? channelsEl.querySelector(".is-on").dataset.channel : null;
  let rounds = [];
  let index = 0;
  let answers = [];
  let usedHint = false;
  let locked = false;

  // --- Helpers -----------------------------------------------------------------

  function fill(template, vars) {
    return String(template).replace(/\{\{(\w+)\}\}/g, (m, name) => (name in vars ? vars[name] : m));
  }

  // Relative rather than absolute on purpose: the exact clock time of a line from two years ago
  // tells a player nothing they can use, while "два года назад" places it in the channel's history.
  function relativeTime(iso) {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days < 1) return L.justNow;
    if (days < 45) return fill(L.daysAgo, { n: days });
    const months = Math.round(days / 30);
    if (months < 18) return fill(L.monthsAgo, { n: months });
    return fill(L.yearsAgo, { n: Math.round(days / 365) });
  }

  // Form-encoded, not JSON: app.js mounts express.urlencoded and nothing else, so a JSON body
  // would arrive empty. The CSRF field rides in the body because that is where middleware/csrf.js
  // looks for it, and it is absent for guests, who have no token at all.
  async function post(url, body) {
    const form = new URLSearchParams(body || {});
    if (DATA.csrfToken) form.set("_csrf", DATA.csrfToken);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    return res.json();
  }

  function show(section) {
    setupEl.hidden = section !== "setup";
    playEl.hidden = section !== "play";
    overEl.hidden = section !== "over";
  }

  function readBest() {
    try {
      return Number(window.localStorage.getItem(BEST_KEY)) || 0;
    } catch (err) {
      return 0; // a private window or blocked site data must not break the end screen
    }
  }

  function writeBest(score) {
    try {
      if (score > readBest()) window.localStorage.setItem(BEST_KEY, String(score));
    } catch (err) {
      /* nothing to do - the best score is a convenience, not state the game needs */
    }
  }

  // --- Setup -------------------------------------------------------------------

  if (channelsEl) {
    channelsEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-channel]");
      if (!button) return;
      channelsEl.querySelectorAll("[data-channel]").forEach((b) => b.classList.remove("is-on"));
      button.classList.add("is-on");
      channel = button.dataset.channel;
    });
  }

  if (playBtn) playBtn.addEventListener("click", start);
  againBtn.addEventListener("click", start);
  understoodBtn.addEventListener("click", () => show("setup"));

  async function start() {
    setupError.hidden = true;
    if (playBtn) playBtn.disabled = true;
    try {
      const res = await post("/games/guess-chatter/start.json", { channel });
      if (!res.ok) throw new Error(res.error || "error");
      rounds = res.rounds;
      index = 0;
      answers = [];
      show("play");
      renderRound();
    } catch (err) {
      setupError.textContent = L.error;
      setupError.hidden = false;
      show("setup");
    } finally {
      if (playBtn) playBtn.disabled = false;
    }
  }

  // --- A round -----------------------------------------------------------------

  function renderRound() {
    const round = rounds[index];
    locked = false;
    usedHint = false;

    progressEl.textContent = fill(L.progress, { n: index + 1, total: rounds.length });
    scoreEl.textContent = fill(L.score, { n: answers.filter((a) => a.correct).length });
    messageEl.textContent = round.text;
    whenEl.textContent = relativeTime(round.at);

    // Hints: three closed doors, each opening to one more line by the same author. Free, so the
    // only thing they cost is the "unaided" tally on the end screen.
    hintsEl.textContent = "";
    round.hints.forEach((hint) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "text-left px-3 py-2 rounded-lg border border-dashed border-neutral-700 " +
        "text-sm text-neutral-500 hover:border-neutral-600 hover:text-neutral-400 transition-colors";
      button.textContent = L.hintButton;
      button.addEventListener(
        "click",
        () => {
          usedHint = true;
          button.textContent = hint; // textContent, never innerHTML - this is chat text
          button.className =
            "text-left px-3 py-2 rounded-lg border border-neutral-800 bg-neutral-900 " +
            "text-sm text-neutral-300 break-words";
          button.disabled = true;
        },
        { once: true }
      );
      hintsEl.appendChild(button);
    });

    contextEl.hidden = true;
    contextEl.textContent = "";
    contextBtn.textContent = L.showContext;
    contextBtn.disabled = false;

    optionsEl.textContent = "";
    round.options.forEach((option) => optionsEl.appendChild(optionButton(round, option)));
  }

  function optionButton(round, option) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.userId = option.userId;
    button.className =
      "flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-800 bg-neutral-900 " +
      "hover:border-neutral-700 transition-colors text-left";

    if (option.avatarUrl) {
      const img = document.createElement("img");
      img.src = option.avatarUrl;
      img.alt = "";
      img.loading = "lazy";
      img.className = "w-9 h-9 rounded-full shrink-0 bg-neutral-800";
      button.appendChild(img);
    } else {
      const blank = document.createElement("span");
      blank.className = "w-9 h-9 rounded-full shrink-0 bg-neutral-800";
      button.appendChild(blank);
    }

    const name = document.createElement("span");
    name.className = "font-medium truncate";
    name.textContent = option.login;
    if (option.color) name.style.color = option.color;
    button.appendChild(name);

    button.addEventListener("click", () => answer(round, option.userId));
    return button;
  }

  function answer(round, userId) {
    if (locked) return;
    locked = true;

    const correct = userId === round.answerId;
    answers.push({ round, chosen: userId, correct, usedHint });

    optionsEl.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
      const isAnswer = button.dataset.userId === round.answerId;
      const isChoice = button.dataset.userId === userId;
      if (isAnswer) button.classList.add("border-emerald-500", "bg-emerald-950/40");
      else if (isChoice) button.classList.add("border-red-500", "bg-red-950/40");
      else button.classList.add("opacity-50");
    });
    scoreEl.textContent = fill(L.score, { n: answers.filter((a) => a.correct).length });

    // No "next" button between rounds: the reveal is one glance, and the breakdown at the end is
    // where the run is actually read back.
    window.setTimeout(() => {
      index += 1;
      if (index >= rounds.length) finish();
      else renderRound();
    }, correct ? 900 : 1600);
  }

  // --- Context -----------------------------------------------------------------

  contextBtn.addEventListener("click", async () => {
    if (!contextEl.hidden) {
      contextEl.hidden = true;
      contextBtn.textContent = L.showContext;
      return;
    }
    contextBtn.disabled = true;
    try {
      const round = rounds[index];
      const url = `/games/guess-chatter/context.json?channel=${encodeURIComponent(channel)}&id=${encodeURIComponent(round.id)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } }).then((r) => r.json());
      renderContext(res.ok ? res.lines : []);
      contextEl.hidden = false;
      contextBtn.textContent = L.hideContext;
    } catch (err) {
      renderContext([]);
      contextEl.hidden = false;
    } finally {
      contextBtn.disabled = false;
    }
  });

  function renderContext(lines) {
    contextEl.textContent = "";
    if (!lines.length) {
      const empty = document.createElement("p");
      empty.className = "text-neutral-500";
      empty.textContent = L.contextEmpty;
      contextEl.appendChild(empty);
      return;
    }
    lines.forEach((line) => {
      const row = document.createElement("p");
      row.className = "break-words" + (line.isAuthor ? " text-purple-300" : " text-neutral-400");
      const who = document.createElement("span");
      who.className = "font-semibold";
      who.textContent = `${line.author}: `;
      row.appendChild(who);
      row.appendChild(document.createTextNode(line.text));
      contextEl.appendChild(row);
    });
  }

  // --- The end -----------------------------------------------------------------

  function finish() {
    const score = answers.filter((a) => a.correct).length;
    const unaided = answers.filter((a) => a.correct && !a.usedHint).length;

    overScoreEl.textContent = fill(L.overScore, { n: score, total: answers.length });
    overUnaidedEl.textContent = fill(L.overUnaided, { n: unaided });
    const best = readBest();
    overBestEl.textContent = best ? fill(L.overBest, { n: best }) : "";
    writeBest(score);

    breakdownEl.textContent = "";
    answers.forEach((entry) => breakdownEl.appendChild(breakdownRow(entry)));

    show("over");
    post("/games/guess-chatter/finish.json").catch(() => {});
  }

  function breakdownRow(entry) {
    const card = document.createElement("div");
    card.className =
      "rounded-xl border p-4 " +
      (entry.correct ? "border-emerald-900 bg-emerald-950/20" : "border-neutral-800 bg-neutral-900");

    const text = document.createElement("p");
    text.className = "text-neutral-200 break-words mb-2";
    text.textContent = entry.round.text;
    card.appendChild(text);

    const truth = document.createElement("p");
    truth.className = "text-sm";
    const mark = document.createElement("span");
    mark.className = entry.correct ? "text-emerald-400" : "text-red-400";
    mark.textContent = entry.correct ? L.correct : L.wrong;
    truth.appendChild(mark);
    truth.appendChild(document.createTextNode(" "));
    const author = document.createElement("span");
    author.className = "font-semibold text-neutral-200";
    author.textContent = nameOf(entry.round, entry.round.answerId);
    truth.appendChild(author);
    if (!entry.correct) {
      const yours = document.createElement("span");
      yours.className = "text-neutral-500";
      yours.textContent = ` ${fill(L.yourAnswer, { name: nameOf(entry.round, entry.chosen) })}`;
      truth.appendChild(yours);
    }
    card.appendChild(truth);

    // The admixed rounds are named only here. During play they must look like any other question;
    // afterwards, "this one was a lottery" is the honest explanation of a miss.
    if (entry.round.admixed) {
      const note = document.createElement("p");
      note.className = "mt-1 text-xs text-neutral-500";
      note.textContent = L.admixed;
      card.appendChild(note);
    }
    return card;
  }

  function nameOf(round, userId) {
    const option = round.options.find((o) => o.userId === userId);
    return option ? option.login : "";
  }
})();
