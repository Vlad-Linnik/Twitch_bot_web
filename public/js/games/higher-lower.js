// "Выше — ниже" (views/gameHigherLower.ejs, routes/higherLower.js).
//
// This client owns no game state worth the name: the server deals every round, keeps the score
// and decides every answer, because the challenger's count is the answer and must not be here
// before the guess is. What lives in this file is the presentation - the count-up, the slide, the
// generated backdrop - plus the setup screen.
//
// Everything is inside one IIFE: public/js/games/*.js are plain non-module <script> tags sharing
// a single global scope, where a second file declaring the same top-level const silently kills
// whichever loads later.
(function () {
  "use strict";

  const dataNode = document.getElementById("hl-data");
  if (!dataNode) return;

  const DATA = JSON.parse(dataNode.textContent);
  const L = DATA.labels;

  // --- Elements ----------------------------------------------------------------

  const setupEl = document.getElementById("hl-setup");
  const playEl = document.getElementById("hl-play");
  const overEl = document.getElementById("hl-over");
  const trackEl = document.getElementById("hl-track");

  const modeGroup = document.getElementById("hl-mode");
  const periodGroup = document.getElementById("hl-period");
  const channelsEl = document.getElementById("hl-channels");
  const playBtn = document.getElementById("hl-play-btn");
  const setupError = document.getElementById("hl-setup-error");

  const hudScore = document.getElementById("hl-hud-score");
  const hudBest = document.getElementById("hl-hud-best");

  const overTitle = document.getElementById("hl-over-title");
  const overBody = document.getElementById("hl-over-body");
  const overScore = document.getElementById("hl-over-score");
  const overNote = document.getElementById("hl-over-note");

  const lbList = document.getElementById("hl-lb-list");
  const lbMe = document.getElementById("hl-lb-me");
  const lbMeRow = document.getElementById("hl-lb-me-row");
  const lbEmptyLabel = document.getElementById("hl-leaderboard").dataset.emptyLabel;
  const localBestEl = document.getElementById("hl-local-best");
  const localBestValue = document.getElementById("hl-local-best-value");

  const resumeEl = document.getElementById("hl-resume");
  const resumeBody = document.getElementById("hl-resume-body");

  // --- Sound -------------------------------------------------------------------

  const SOUND_BASE = "/sounds/games/higher-lower/";
  const SOUNDS = {
    correct: new Audio(SOUND_BASE + "correct.wav"),
    wrong: new Audio(SOUND_BASE + "wrong.wav"),
    tick: new Audio(SOUND_BASE + "tick.wav"),
  };
  SOUNDS.correct.volume = 0.5;
  SOUNDS.wrong.volume = 0.45;
  // The tick fires many times during one count-up, so it sits far below the other two.
  SOUNDS.tick.volume = 0.12;

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

  // --- Dealt-ahead cards --------------------------------------------------------
  //
  // The server deals two rounds beyond the one on screen and sends everything about them except
  // the count, which is the answer and can never come early. Two things follow. Answering costs
  // one small round trip and no dealing at all, which is what removes the stall between the click
  // and the number. And the pictures can be fetched now: a card is otherwise built at the moment
  // it starts sliding into view, so a cold emote arrives on screen as a blank panel.
  const warmed = [];

  function preload(cards) {
    (cards || []).forEach((card) => {
      if (!card || !card.image) return;
      const img = new Image();
      img.src = card.image;
      // Held on purpose: an Image nobody references can be collected before its fetch lands.
      warmed.push(img);
      if (warmed.length > 8) warmed.shift();
    });
  }

  // --- State -------------------------------------------------------------------

  let mode = "words";
  let period = "all";
  let channel = null;
  let channels = DATA.channels || [];
  let run = null; // {runId, turn, score}
  let busy = false;

  const locale = document.documentElement.lang || "ru";
  const fmt = (n) => Number(n).toLocaleString(locale);

  // --- 67 ----------------------------------------------------------------------
  //
  // Every number on screen gets its 67s picked out in another colour - 167, 670, 12 671. A gag
  // rather than information, so it is colour only: nothing about the weight or the size of a
  // digit changes, and a number with no 67 in it renders exactly as it did.
  //
  // The search runs over the digits alone and the formatted string is marked back from them,
  // because the number is grouped for the locale by the time it is shown: in «6 712» the pair is
  // real and only the thousands separator stands between the two digits. Marking that separator
  // too keeps such a pair one span instead of two.
  const LUCKY = "67";

  function numberNodes(value) {
    const text = fmt(value);
    const at = []; // where each digit of `bare` sits in `text`
    let bare = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] >= "0" && text[i] <= "9") {
        at.push(i);
        bare += text[i];
      }
    }

    const mark = new Array(text.length).fill(false);
    for (let hit = bare.indexOf(LUCKY); hit !== -1; hit = bare.indexOf(LUCKY, hit + 1)) {
      for (let i = at[hit]; i <= at[hit + LUCKY.length - 1]; i++) mark[i] = true;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < text.length; ) {
      let j = i;
      while (j < text.length && mark[j] === mark[i]) j++;
      const chunk = text.slice(i, j);
      if (mark[i]) {
        const span = document.createElement("span");
        span.className = "hl-67";
        span.textContent = chunk;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(chunk));
      }
      i = j;
    }
    return frag;
  }

  // Every number the player is shown goes through here rather than through textContent.
  function setNumber(el, value) {
    el.textContent = "";
    el.appendChild(numberNodes(value));
  }

  // --- Personal best (month runs only) -----------------------------------------
  //
  // The month leaderboard deliberately does not exist server-side: a streak set on a rolling
  // 30-day window is scored against data that will not be there next month. The browser keeps
  // that record instead, per mode.

  const bestKey = () => `hlBest:${mode}:${period}:${channel || ""}`;

  function readLocalBest() {
    try {
      return parseInt(localStorage.getItem(bestKey()), 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  function writeLocalBest(score) {
    try {
      if (score > readLocalBest()) localStorage.setItem(bestKey(), String(score));
    } catch (_) {
      /* storage blocked - the record simply does not persist */
    }
  }

  // --- Generated backdrop ------------------------------------------------------
  //
  // A chat word has no photograph behind it the way this genre usually has one, so the panel's
  // fixture is derived from the token itself: same word, same backdrop, every time, with nothing
  // stored anywhere. FNV-1a because it is four lines and spreads short strings well.

  function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function backdropVars(token) {
    const h = hash32(token);
    return {
      "--hue": String(h % 360),
      "--bx": (12 + ((h >>> 9) % 76)) + "%",
      "--by": (10 + ((h >>> 15) % 60)) + "%",
      "--cx": (14 + ((h >>> 21) % 72)) + "%",
      "--cy": (34 + ((h >>> 3) % 58)) + "%",
    };
  }

  // --- Panels ------------------------------------------------------------------

  // --- Rating -------------------------------------------------------------------
  //
  // Two pairs of thumbs per word card: one rates the word (how often it gets dealt), one rates the
  // sentence under it (how often that sentence is printed). Both run on the same curve server-side
  // - a like holds it where it is, dislikes thin it out, enough of them retire it.
  //
  // Voting is for signed-in players; a guest gets the buttons disabled with a title saying why,
  // rather than a row of controls that silently do nothing.

  function voteButton(card, target, value) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hl-vote";
    btn.dataset.target = target;
    btn.dataset.value = String(value);
    btn.textContent = value === 1 ? "👍" : "👎";
    btn.title = DATA.loggedIn ? "" : L.voteLogin;
    btn.disabled = !DATA.loggedIn;
    if (card.myVotes && card.myVotes[target] === value) btn.classList.add("is-on");

    btn.addEventListener("click", async () => {
      if (!DATA.loggedIn) return;
      const row = btn.parentElement;
      row.querySelectorAll(".hl-vote").forEach((b) => (b.disabled = true));
      try {
        const res = await post("/games/higher-lower/vote.json", {
          channel: channel,
          word: card.label,
          target,
          value,
        });
        if (res && res.ok) {
          // The server is the authority on what the vote now IS - pressing a lit thumb clears it -
          // so the row is repainted from the answer rather than from what was clicked.
          row.querySelectorAll(".hl-vote").forEach((b) => {
            b.classList.toggle("is-on", Number(b.dataset.value) === res.value);
          });
        }
      } catch (_) {
        /* a lost vote is not worth interrupting a run for */
      }
      row.querySelectorAll(".hl-vote").forEach((b) => (b.disabled = false));
    });
    return btn;
  }

  function voteRow(card, target, label) {
    const row = document.createElement("div");
    row.className = "hl-vote-row";
    const caption = document.createElement("span");
    caption.className = "hl-vote-label";
    caption.textContent = label;
    row.append(caption, voteButton(card, target, 1), voteButton(card, target, -1));
    return row;
  }

  function voteBar(card) {
    const bar = document.createElement("div");
    bar.className = "hl-votes";
    bar.appendChild(voteRow(card, "word", L.voteWord));

    // Nothing to rate when the word has no line under it - either none was ever found, or this one
    // has already been voted down far enough to stop appearing. The row is still built and merely
    // made invisible, because the two cards have to stay the same height: otherwise the card whose
    // word happens to have no quote would put its number on a different line from the other's.
    const exampleRow = voteRow(card, "example", L.voteExample);
    if (!card.example) exampleRow.classList.add("hl-vote-row-empty");
    bar.appendChild(exampleRow);
    return bar;
  }

  // The quotation block: a real line from that chat with the word in it, signed with the name the
  // person was using when they wrote it. This is what stands in for the photograph the genre
  // usually puts behind an item. textContent throughout - every character of it is viewer-written.
  //
  // The block is built even when there is no line (roughly one pool word in a hundred has none,
  // and a channel has none at all until the job has run once), because it reserves the height
  // either way: otherwise the card with a quote and the card without would put their numbers on
  // different lines.
  function exampleNode(card) {
    const wrap = document.createElement("div");
    wrap.className = "hl-example";

    const text = document.createElement("span");
    text.className = "hl-example-text";
    if (card.example) {
      // The quote is a chat line, so its emotes are printed as pictures rather than as their
      // names - the server sent the handful this line uses alongside it. Guillemets are added as
      // their own text nodes so the body can be built by EmoteMatch without string concatenation
      // ever touching viewer-written text.
      const index = window.EmoteMatch ? window.EmoteMatch.buildEmoteIndex(card.example.emotes) : null;
      const body = document.createElement("span");
      if (window.EmoteMatch) window.EmoteMatch.renderChatText(body, card.example.text, index);
      else body.textContent = card.example.text;
      text.appendChild(document.createTextNode("«"));
      text.appendChild(body);
      text.appendChild(document.createTextNode("»"));
    }
    wrap.appendChild(text);

    const author = document.createElement("span");
    author.className = "hl-example-author";
    // A row written before attribution existed has no author; the quote then stands unsigned
    // rather than the whole thing disappearing.
    author.textContent = card.example && card.example.author ? "— " + card.example.author : "";
    wrap.appendChild(author);

    wrap.appendChild(voteBar(card));
    return wrap;
  }

  function tokenNode(card) {
    if (card.image) {
      // Picture AND name. An emote is typed by its name in chat, the other card's caption refers
      // to this one by that name ("...than «LULE»"), and a channel's set contains pictures a
      // visitor may not recognise at all - so the label is not decoration here.
      const wrap = document.createElement("div");
      wrap.className = "hl-emote";

      const img = document.createElement("img");
      img.className = "hl-emote-img";
      img.src = card.image;
      img.alt = card.label;
      // An emote can leave the channel's 7TV set while its usage stays in the stats, and the URL
      // then 404s. Dropping to the name alone keeps the round playable.
      img.addEventListener("error", () => {
        img.remove();
        name.className = "hl-token";
      });

      const name = document.createElement("div");
      name.className = "hl-emote-name";
      name.textContent = card.label;

      wrap.append(img, name);
      return wrap;
    }
    const div = document.createElement("div");
    div.className = "hl-token";
    div.textContent = card.label;
    return div;
  }

  function makePanel(card, slot) {
    const panel = document.createElement("div");
    panel.className = "hl-panel";
    const vars = backdropVars(card.label);
    Object.keys(vars).forEach((k) => panel.style.setProperty(k, vars[k]));
    panel.style.setProperty("--slot", String(slot));

    // The token sits in a head of its own so the two halves line up even when one card is a
    // picture and the other is a word - which is routine in the emote mode, where only part of a
    // channel's set still resolves to an image.
    const head = document.createElement("div");
    head.className = "hl-head";
    head.appendChild(tokenNode(card));

    // A real line from that chat with the word in it - what stands in for the photograph this
    // genre usually puts behind an item. Always textContent: this is viewer-written text.
    //
    // The element is added even when there is no line (roughly one pool word in a hundred has
    // none, and a channel has none at all until the job has run once), because it reserves the
    // space either way - otherwise the card that has a quote and the card that does not would put
    // their numbers at different heights.
    if (mode === "words") head.appendChild(exampleNode(card));
    panel.appendChild(head);

    const has = document.createElement("div");
    has.className = "hl-has";
    has.textContent = L.has;
    panel.appendChild(has);
    return panel;
  }

  // The number and the buttons both live in a .hl-slot of fixed height, so the two halves'
  // words sit at the same y no matter which side is showing which.
  function slot(child) {
    const wrap = document.createElement("div");
    wrap.className = "hl-slot";
    wrap.appendChild(child);
    return wrap;
  }

  function countNode(value) {
    const count = document.createElement("div");
    count.className = "hl-count";
    setNumber(count, value);
    return count;
  }

  // The anchor: label, "appears in", the number, "messages".
  function anchorPanel(card, slotIndex) {
    const panel = makePanel(card, slotIndex);
    panel.appendChild(slot(countNode(card.count)));

    const unit = document.createElement("div");
    unit.className = "hl-unit";
    unit.textContent = L.messages;
    panel.appendChild(unit);
    return panel;
  }

  // The challenger: label, "appears in", the two buttons, "messages than <anchor>".
  function challengerPanel(card, slotIndex, anchorLabel) {
    const panel = makePanel(card, slotIndex);

    const choices = document.createElement("div");
    choices.className = "hl-choices";
    [
      { guess: "higher", text: L.higher, arrow: "▲" },
      { guess: "lower", text: L.lower, arrow: "▼" },
    ].forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hl-choice";
      btn.dataset.guess = opt.guess;
      btn.textContent = opt.text + " " + opt.arrow;
      btn.addEventListener("click", () => answer(opt.guess));
      choices.appendChild(btn);
    });
    panel.appendChild(slot(choices));

    const unit = document.createElement("div");
    unit.className = "hl-unit";
    unit.textContent = L.comparePrefix + " «" + anchorLabel + "»";
    panel.appendChild(unit);
    return panel;
  }

  function panels() {
    return Array.from(trackEl.querySelectorAll(".hl-panel"));
  }

  // --- Count-up ----------------------------------------------------------------

  // Replaces the challenger's buttons with its real number, counted up. Resolves when the number
  // has landed, so the caller can flash and slide in order rather than on timers.
  function revealCount(panel, value) {
    const choices = panel.querySelector(".hl-choices");
    const count = countNode(0);
    // Swapped inside the .hl-slot the buttons were in, so the card does not jump as the number
    // takes their place.
    if (choices) choices.replaceWith(count);
    else panel.appendChild(slot(count));

    const unit = panel.querySelector(".hl-unit");
    if (unit) unit.textContent = L.messages;

    return new Promise((resolve) => {
      const DURATION = 850;
      const started = performance.now();
      let lastTick = 0;

      function frame(now) {
        const t = Math.min(1, (now - started) / DURATION);
        // Ease-out: fast at first, crawling at the end, which is what makes a close call read as
        // tense rather than as a number appearing.
        const eased = 1 - Math.pow(1 - t, 3);
        setNumber(count, Math.round(value * eased));
        if (now - lastTick > 90 && t < 1) {
          lastTick = now;
          playSound("tick");
        }
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          setNumber(count, value);
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Sliding -----------------------------------------------------------------

  // Moves the strip one panel along: the spent anchor leaves, the answered challenger takes its
  // place and the freshly dealt card arrives. The transform is cleared afterwards under
  // .hl-noanim, so the renumbered panels do not animate back to where they already are.
  function slide(nextPanel) {
    trackEl.appendChild(nextPanel);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        trackEl.removeEventListener("transitionend", finish);

        const list = panels();
        if (list.length) list[0].remove();
        panels().forEach((panel, i) => panel.style.setProperty("--slot", String(i)));

        trackEl.classList.add("hl-noanim");
        trackEl.classList.remove("hl-advance");
        void trackEl.offsetWidth; // flush the transform before transitions come back
        trackEl.classList.remove("hl-noanim");
        resolve();
      };
      trackEl.addEventListener("transitionend", finish);
      // transitionend does not fire if the animation is suppressed (reduced motion, a background
      // tab); the timer is what keeps the game from freezing mid-round in that case.
      setTimeout(finish, 900);
      requestAnimationFrame(() => trackEl.classList.add("hl-advance"));
    });
  }

  // --- Play --------------------------------------------------------------------

  function setChoicesEnabled(enabled) {
    trackEl.querySelectorAll(".hl-choice").forEach((btn) => {
      btn.disabled = !enabled;
    });
  }

  // Form-encoded, not JSON: app.js mounts express.urlencoded and nothing else, so a JSON body
  // would arrive as an empty req.body. The CSRF field rides in the body because that is where
  // middleware/csrf.js looks for it, and it is absent for guests, who have no token at all.
  async function post(url, body) {
    const form = new URLSearchParams(body);
    if (DATA.csrfToken) form.set("_csrf", DATA.csrfToken);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    return res.json();
  }

  function showRound(round) {
    // The labels are kept here rather than read back off the DOM: the anchor's label is needed to
    // caption the NEXT challenger ("...messages than «чат»"), and an emote card carries a picture
    // where a word card carries text, so there is no one node to read it from.
    run = {
      runId: round.runId,
      turn: round.turn,
      score: round.score,
      anchorLabel: round.left.label,
      challengerLabel: round.right.label,
    };
    trackEl.innerHTML = "";
    trackEl.classList.remove("hl-advance");
    // Only the emote mode reserves head height for a picture; in the word mode that space would
    // just push every card down.
    trackEl.classList.toggle("hl-emotes", round.mode === "emotes");
    trackEl.appendChild(anchorPanel(round.left, 0));
    trackEl.appendChild(challengerPanel(round.right, 1, round.left.label));
    preload(round.upcoming);
    setNumber(hudScore, round.score);
    setNumber(hudBest, readLocalBest());
    show(playEl);
  }

  async function answer(guess) {
    if (busy || !run) return;
    busy = true;
    setChoicesEnabled(false);

    let res;
    try {
      res = await post("/games/higher-lower/answer.json", {
        runId: run.runId,
        turn: run.turn,
        guess,
      });
    } catch (_) {
      busy = false;
      setChoicesEnabled(true);
      return;
    }

    if (!res || !res.ok) {
      // A 409 means this run is gone (expired, or answered from another tab). There is nothing
      // to recover, so hand the player back to the setup screen rather than a dead board.
      busy = false;
      run = null;
      show(setupEl);
      return;
    }

    const list = panels();
    const challenger = list[1];
    await revealCount(challenger, res.revealed);

    challenger.classList.add(res.correct ? "hl-ok" : "hl-bad");
    playSound(res.correct ? "correct" : "wrong");

    if (res.correct && !res.finished) {
      // Warmed before the animation rather than after it: the count-up, the flash and the slide
      // are about a second and a half of cover for a picture two rounds away.
      preload(res.upcoming);
      run.turn = res.turn;
      run.score = res.score;
      setNumber(hudScore, res.score);
      await wait(420);
      challenger.classList.remove("hl-ok");
      // The card just answered becomes the anchor, so it is what the new challenger is compared
      // against in the caption.
      const nextPanel = challengerPanel(res.next, 2, run.challengerLabel);
      run.anchorLabel = run.challengerLabel;
      run.challengerLabel = res.next.label;
      await slide(nextPanel);
      busy = false;
      return;
    }

    await wait(900);
    finishRun(res);
    busy = false;
  }

  function finishRun(res) {
    run = null;
    writeLocalBest(res.score);

    overTitle.textContent = res.cleared ? L.clearedTitle : L.gameOver;
    overBody.textContent = res.cleared ? L.clearedBody : "";
    overBody.hidden = !res.cleared;
    setNumber(overScore, res.score);

    if (res.ranked) {
      overNote.hidden = true;
      // The response already carries this channel/mode's table as the run just left it, so no
      // second fetch is needed to show the player where they landed.
      renderLeaderboard(res.leaderboard);
    } else {
      overNote.textContent = L.notRanked;
      overNote.hidden = false;
    }
    refreshLocalBest();
    show(overEl);
  }

  // --- Leaderboard -------------------------------------------------------------

  function lbRow(row, isMe) {
    const li = document.createElement("li");
    li.className =
      "flex items-baseline gap-2 text-sm py-1 px-1 rounded" + (isMe ? " bg-purple-500/10" : "");

    const rank = document.createElement("span");
    rank.className = "w-5 text-right tabular-nums text-neutral-500 shrink-0";
    rank.textContent = String(row.rank);

    const name = document.createElement("span");
    name.className = "flex-1 truncate " + (isMe ? "text-purple-300" : "text-neutral-300");
    if (row.color) name.style.color = row.color;
    name.textContent = row.displayName;

    const score = document.createElement("span");
    score.className = "tabular-nums text-neutral-100";
    setNumber(score, row.score);

    li.append(rank, name, score);
    return li;
  }

  function renderLeaderboard(board) {
    lbList.innerHTML = "";
    if (!board || !board.rows.length) {
      const li = document.createElement("li");
      li.className = "text-sm text-neutral-500 py-1";
      li.textContent = lbEmptyLabel;
      lbList.appendChild(li);
    } else {
      board.rows.forEach((row) => lbList.appendChild(lbRow(row, row.isMe)));
    }

    lbMeRow.innerHTML = "";
    if (board && board.myRow) {
      lbMeRow.appendChild(lbRow(board.myRow, true));
      lbMe.hidden = false;
    } else {
      lbMe.hidden = true;
    }
  }

  function refreshLocalBest() {
    const best = readLocalBest();
    setNumber(localBestValue, best);
    localBestEl.hidden = best === 0;
    setNumber(hudBest, best);
  }

  // --- Setup screen ------------------------------------------------------------

  // One leaderboard element serves both the setup and the end-of-run screens - it is moved
  // between their mount points rather than duplicated, so there is only ever one copy to keep in
  // step with what a run just changed.
  const lbSlots = {
    setup: document.getElementById("hl-lb-slot-setup"),
    over: document.getElementById("hl-lb-slot-over"),
  };
  const boardEl = document.getElementById("hl-leaderboard");

  function show(section) {
    [setupEl, playEl, overEl].forEach((el) => {
      el.hidden = el !== section;
    });
    if (section === overEl) lbSlots.over.appendChild(boardEl);
    else if (section === setupEl) lbSlots.setup.appendChild(boardEl);
  }

  function renderChannels() {
    channelsEl.innerHTML = "";
    if (!channels.length) {
      const p = document.createElement("p");
      p.className = "text-sm text-neutral-500";
      p.textContent = channelsEl.dataset.emptyLabel;
      channelsEl.appendChild(p);
      channel = null;
      playBtn.disabled = true;
      return;
    }

    // Keep the current pick if it survived the mode/period switch, otherwise take the largest
    // pool - which is also the most interesting chat to play.
    if (!channels.some((c) => c.channelLogin === channel)) channel = channels[0].channelLogin;

    channels.forEach((c) => {
      const label = document.createElement("label");
      label.className =
        "flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors " +
        (c.channelLogin === channel
          ? "border-purple-600 bg-purple-950/40"
          : "border-neutral-800 bg-neutral-950 hover:border-neutral-700");

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "hl-channel";
      radio.value = c.channelLogin;
      radio.checked = c.channelLogin === channel;
      radio.className = "accent-purple-500";
      radio.addEventListener("change", () => {
        channel = c.channelLogin;
        renderChannels();
        loadBoard();
        refreshLocalBest();
      });

      const name = document.createElement("span");
      name.className = "flex-1 text-sm text-neutral-200";
      name.textContent = c.channelLogin;

      const pool = document.createElement("span");
      pool.className = "text-xs text-neutral-500 tabular-nums";
      pool.textContent = channelsEl.dataset.poolLabel + " " + fmt(c.poolSize);

      label.append(radio, name, pool);
      channelsEl.appendChild(label);
    });

    playBtn.disabled = false;
  }

  async function loadChannels() {
    channelsEl.innerHTML = "";
    const p = document.createElement("p");
    p.className = "text-sm text-neutral-500";
    p.textContent = channelsEl.dataset.loadingLabel;
    channelsEl.appendChild(p);
    playBtn.disabled = true;

    try {
      const res = await fetch(
        "/games/higher-lower/channels.json?mode=" + mode + "&period=" + period
      );
      const json = await res.json();
      channels = json.ok ? json.channels : [];
    } catch (_) {
      channels = [];
    }
    renderChannels();
    await loadBoard();
    refreshLocalBest();
  }

  // Every channel/mode pairing is its own ladder, so the table is fetched rather than carried in
  // the page: the picker can reach far more of them than it would be worth rendering up front.
  async function loadBoard() {
    if (!channel) return renderLeaderboard(null);
    try {
      const res = await fetch(
        "/games/higher-lower/board.json?mode=" + mode + "&channel=" + encodeURIComponent(channel)
      );
      const json = await res.json();
      renderLeaderboard(json.ok ? json.board : null);
    } catch (_) {
      renderLeaderboard(null);
    }
  }

  function wireToggle(group, attr, onPick) {
    group.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("is-on")) return;
        group.querySelectorAll("button").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        onPick(btn.dataset[attr]);
      });
    });
  }

  wireToggle(modeGroup, "mode", (value) => {
    mode = value;
    loadChannels();
  });
  wireToggle(periodGroup, "period", (value) => {
    period = value;
    loadChannels();
  });

  // The error line lives on the setup screen, so a failed start has to bring the visitor back to
  // it - "Ещё раз" on the end-of-run screen presses this same button, and without this the click
  // would just look like nothing happened.
  function failToStart() {
    setupError.hidden = false;
    show(setupEl);
  }

  playBtn.addEventListener("click", async () => {
    if (busy || !channel) return;
    busy = true;
    setupError.hidden = true;
    playBtn.disabled = true;
    try {
      const res = await post("/games/higher-lower/start.json", { mode, period, channel });
      if (res && res.ok) showRound(res.round);
      else failToStart();
    } catch (_) {
      failToStart();
    }
    playBtn.disabled = false;
    busy = false;
  });

  document.getElementById("hl-again").addEventListener("click", () => {
    playBtn.click();
  });
  document.getElementById("hl-back-setup").addEventListener("click", () => {
    show(setupEl);
  });

  // --- Resume ------------------------------------------------------------------

  if (DATA.resume) {
    const r = DATA.resume;
    resumeBody.textContent = L.resumeBody.replace("{{score}}", fmt(r.score));
    resumeEl.hidden = false;

    document.getElementById("hl-resume-go").addEventListener("click", () => {
      mode = r.mode;
      period = r.period;
      channel = r.channel;
      showRound(r);
    });
    document.getElementById("hl-resume-drop").addEventListener("click", () => {
      resumeEl.hidden = true;
    });
  }

  // --- Boot --------------------------------------------------------------------

  renderChannels();
  // The server rendered the table for the channel renderChannels() just preselected, so the first
  // paint needs no fetch; every later change of channel or mode goes through loadBoard().
  renderLeaderboard(DATA.board);
  refreshLocalBest();
})();
