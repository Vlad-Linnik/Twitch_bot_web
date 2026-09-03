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

  // --- Sound -------------------------------------------------------------------
  //
  // Its own folder, like every other game with sound: the files are copies rather than references
  // into a sibling's directory, so one game's re-cut never silently changes another's.
  //
  // `correct` and `wrong` are the same two cues the other quiz on this site uses, on purpose - a
  // player moving between them should not have to learn a second vocabulary.
  const SOUND_BASE = "/sounds/games/guess-chatter/";
  const SOUNDS = {
    correct: new Audio(SOUND_BASE + "correct.wav"),
    wrong: new Audio(SOUND_BASE + "wrong.wav"),
    hint: new Audio(SOUND_BASE + "hint.wav"),
    finish: new Audio(SOUND_BASE + "finish.wav"),
    next: new Audio(SOUND_BASE + "next.wav"),
  };
  SOUNDS.correct.volume = 0.5;
  // Measured at a peak of 0.06 - a quiet, low, falling tone - so it needs more of the slider than
  // the others to sit level with them.
  SOUNDS.wrong.volume = 0.5;
  SOUNDS.hint.volume = 0.35;
  SOUNDS.finish.volume = 0.4;
  // Fires ten times a run, under the reveal that precedes it: a texture, not an event.
  SOUNDS.next.volume = 0.12;

  function playSound(name) {
    const base = SOUNDS[name];
    if (!base) return;
    try {
      const node = base.cloneNode(true);
      node.volume = base.volume * (window.gameVolume ? window.gameVolume.get() : 1);
      node.play().catch(() => {});
    } catch (_) {
      /* audio blocked or unsupported - the game keeps working silently */
    }
  }

  // Restarts a one-shot animation on an element that may already be carrying it: removing the
  // class is not enough on its own, the browser needs a reflow between removal and re-add.
  function animate(el, className) {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  // --- State -------------------------------------------------------------------

  let channel = channelsEl ? channelsEl.querySelector(".is-on").dataset.channel : null;
  let rounds = [];
  let index = 0;
  let answers = [];
  let usedHint = false;
  let locked = false;
  // name -> {name, url} for the emotes these questions use, built from what start.json sent. The
  // set is per run rather than per channel because a screenful of chat needs a handful of it.
  let emoteIndex = new Map();

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

  // Every place a chat line is printed goes through here, so an emote looks the same in the
  // question, in a hint, in the context and in the breakdown. EmoteMatch builds Text and <img>
  // nodes and never touches innerHTML - the standing rule for viewer-written text.
  function chatText(el, text, override) {
    return window.EmoteMatch
      ? window.EmoteMatch.renderChatText(el, text, override || emoteIndex)
      : ((el.textContent = String(text || "")), el);
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
      emoteIndex = window.EmoteMatch ? window.EmoteMatch.buildEmoteIndex(res.emotes) : new Map();
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
    chatText(messageEl, round.text);
    whenEl.textContent = relativeTime(round.at);
    animate(messageEl.parentElement, "gc-enter");
    // Silent on the first question: the run has only just started and there is nothing to have
    // moved on FROM.
    if (index > 0) playSound("next");

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
          playSound("hint");
          chatText(button, hint);
          button.className =
            "text-left px-3 py-2 rounded-lg border border-neutral-800 bg-neutral-900 " +
            "text-sm text-neutral-300 break-words";
          button.disabled = true;
          animate(button, "gc-hint-open");
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
    animate(optionsEl, "gc-enter-late");
  }

  function optionButton(round, option) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.userId = option.userId;
    button.className =
      "gc-option flex items-center gap-3 px-3 py-2.5 rounded-lg border border-neutral-800 " +
      "bg-neutral-900 hover:border-neutral-700 text-left";

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
      // Colour and motion are separate classes on purpose: animate() removes and re-adds its
      // class to restart the keyframes, and a colour riding along with it would blink off for a
      // frame. The colour also has to survive prefers-reduced-motion, where the animation does not.
      if (isAnswer) {
        button.classList.add("gc-right");
        animate(button, "gc-is-correct");
      } else if (isChoice) {
        button.classList.add("gc-wrong");
        animate(button, "gc-is-wrong");
      } else {
        button.classList.add("gc-is-muted");
      }
    });
    playSound(correct ? "correct" : "wrong");
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
      renderContext(res.ok ? res.lines : [], res.ok ? res.emotes : []);
      contextEl.hidden = false;
      contextBtn.textContent = L.hideContext;
    } catch (err) {
      renderContext([], []);
      contextEl.hidden = false;
    } finally {
      contextBtn.disabled = false;
    }
  });

  function renderContext(lines, emotes) {
    // The surrounding lines are not the ones the run was built from, so they bring their own
    // emotes; merged over the run's rather than replacing them, since both are on screen at once.
    const contextIndex = window.EmoteMatch
      ? window.EmoteMatch.buildEmoteIndex([...(emotes || []), ...emoteIndex.values()])
      : new Map();
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
      const body = document.createElement("span");
      chatText(body, line.text, contextIndex);
      row.appendChild(body);
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
    answers.forEach((entry, i) => {
      const card = breakdownRow(entry);
      // Capped so a ten-card list is fully dealt in about a third of a second rather than growing
      // with the run length.
      card.style.setProperty("--gc-i", String(Math.min(i, 6)));
      breakdownEl.appendChild(card);
    });

    show("over");
    playSound("finish");
    post("/games/guess-chatter/finish.json").catch(() => {});
  }

  function breakdownRow(entry) {
    const card = document.createElement("div");
    card.className =
      "gc-breakdown-card rounded-xl border p-4 " +
      (entry.correct ? "border-emerald-900 bg-emerald-950/20" : "border-neutral-800 bg-neutral-900");

    const text = document.createElement("p");
    text.className = "text-neutral-200 break-words mb-2";
    chatText(text, entry.round.text);
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
