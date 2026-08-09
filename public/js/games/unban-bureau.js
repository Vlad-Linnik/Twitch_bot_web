// «Бюро амнистии» — client for /:channel/unban-bureau (views/unbanBureau.ejs).
//
// Runs the whole desk: a queue of pedestrians on the street, an applicant who walks up to the
// window when called, five documents you physically drag around, a stamp machine that slides out
// of the right wall, and a rifle scope for the "stray bullet".
//
// NOTHING HERE TALKS TO TWITCH. Handing a stamped visa back through the window POSTs to
// decide.json, which only RECORDS the decision; TwitchBot/twitch/unbanRequestScheduler.js applies
// it within ~60s. A sniper shot POSTs to sniper.json, which the bot picks up on its own fast poll.
// That's why a stamped case reads "queued" until live.json reports the bot got to it.
//
// HARD RULE, not a style preference: every string that came out of Mongo or from a user — appeal
// text, chat messages, logins, ban reasons — is rendered through textContent (the `el()` helper),
// never innerHTML. A chat message is attacker-controlled input on a page a tier-2 moderator is
// logged into. The one exception is the three inline <svg> badges, which are constants defined
// here and contain no interpolated data.
//
// GEOMETRY: #ub-wrapper is a fixed 1920x1080 canvas scaled to the viewport (see resize()). Every
// coordinate below is in that design space, so pointer positions must be divided by the current
// scale before they mean anything — that's what toStage() is for.
(function () {
  "use strict";

  var config = document.getElementById("ub-config");
  if (!config) return; // empty queue — the view rendered the empty state instead

  var CHANNEL = config.dataset.channel;
  var CSRF = config.dataset.csrf || "";
  var LOCALE = config.dataset.locale || "en";
  var T = JSON.parse(config.dataset.i18n);
  var cases = JSON.parse(config.dataset.cases);
  var newestFirst = config.dataset.newestFirst === "1";
  var HEARTBEAT_MS = parseInt(config.dataset.heartbeatMs, 10) || 25000;
  // name -> {name, url}, same channel-wide map the news comments box resolves against
  // (public/js/emoteMatch.js, shared with that page). Used to swap emote names for their real
  // image in the appeal text and chat log - EmoteMatch.tokenizeForPreview does the whole-token
  // matching, appendWithEmotes below turns its output into Text/<img> nodes.
  var EMOTE_INDEX = window.EmoteMatch
    ? window.EmoteMatch.buildEmoteIndex(JSON.parse(config.dataset.emotes || "[]"))
    : new Map();

  var DESIGN_W = 1920;
  var DESIGN_H = 1080;
  var LIVE_POLL_MS = 3000;
  // How long an appeal must stay on screen before chat is asked about it - see scheduleVote.
  var VOTE_START_DELAY_MS = 1500;
  var IMG = "/img/games/unban-bureau/";
  var SND = "/sounds/games/unban-bureau/";
  var BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  function $(id) { return document.getElementById(id); }

  var wrapper = $("ub-wrapper");
  var street = $("ub-street");

  var scale = 1;
  // One physical screen pixel expressed in design-space units — walker positions are snapped to
  // this grid rather than to whole design pixels (see snapToPixel).
  var designPerDevicePx = 1;
  var current = 0;
  var currentDecision = null; // 'approved' | 'denied' — set by stamping, required to submit
  var isProcessing = false;
  var stats = { approved: 0, denied: 0, handled: 0 };
  var announcedShots = {};
  var pickMode = newestFirst ? "newest" : "oldest";

  // --- scale ---------------------------------------------------------------

  function resize() {
    scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    wrapper.style.transform = "translate(-50%, -50%) scale(" + scale + ")";
    var deviceScale = scale * (window.devicePixelRatio || 1);
    designPerDevicePx = deviceScale > 0 ? 1 / deviceScale : 1;
  }
  window.addEventListener("resize", resize);

  // Pointer position in the 1920x1080 design space.
  function toStage(event) {
    var rect = wrapper.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  }

  // --- sound ---------------------------------------------------------------

  var vol = { master: 0.5, drag: 1, stamp: 1, printer: 0.8, spit: 1, speaker: 0.4, shoot: 0.6 };
  var sounds = {
    dragStart: [new Audio(SND + "paper-dragstart0.wav"), new Audio(SND + "paper-dragstart1.wav"), new Audio(SND + "paper-dragstart2.wav")],
    dragStop: [new Audio(SND + "paper-dragstop0.wav"), new Audio(SND + "paper-dragstop1.wav"), new Audio(SND + "paper-dragstop2.wav")],
    stampUp: new Audio(SND + "stamp-up.wav"),
    stampDown: new Audio(SND + "stamp-down.wav"),
    printer: new Audio(SND + "printer-feed.wav"),
    spit: new Audio(SND + "paper-spit.wav"),
    speaker: new Audio(SND + "speaker.wav"),
    shoot: new Audio(SND + "shoot.wav"),
  };
  // No dedicated pickup/holster foley exists yet - reusing the stamp machine's clicks (its own
  // Audio objects, not new ones) is closer to a rifle bolt than arming the sniper in total silence.
  sounds.sniperArm = sounds.stampDown;
  sounds.sniperDisarm = sounds.stampUp;
  // Which slider governs which clip.
  var SOUND_CHANNEL = {
    dragStart: "drag", dragStop: "drag", stampUp: "stamp", stampDown: "stamp",
    printer: "printer", spit: "spit", speaker: "speaker", shoot: "shoot",
    sniperArm: "shoot", sniperDisarm: "shoot",
  };

  function play(name) {
    var item = sounds[name];
    if (!item) return;
    var clip = Array.isArray(item) ? item[Math.floor(Math.random() * item.length)] : item;
    try {
      clip.volume = Math.max(0, Math.min(1, vol[SOUND_CHANNEL[name]] * vol.master));
      clip.currentTime = 0;
      clip.play().catch(function () {});
    } catch (err) { /* audio blocked — the desk keeps working silently */ }
  }

  // --- DOM helpers ---------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Same substitution the news comments box does (lib/commentEmotes.js's renderCommentBody), but
  // built out of real DOM nodes instead of an HTML string - this page's hard rule is that no
  // Mongo/user-sourced text ever goes through innerHTML (see the file header). Every token that
  // isn't a recognized emote name still goes through document.createTextNode, so this doesn't
  // weaken that rule at all - the only element ever created is an <img> whose src came from our
  // own EMOTE_INDEX, never from the message text itself.
  function appendWithEmotes(parent, text) {
    if (!window.EmoteMatch || !EMOTE_INDEX.size) {
      parent.appendChild(document.createTextNode(text || ""));
      return;
    }
    window.EmoteMatch.tokenizeForPreview(text || "", EMOTE_INDEX).forEach(function (token) {
      if (token.type === "emote") {
        var img = document.createElement("img");
        img.src = token.url;
        img.alt = token.name;
        img.title = token.name;
        img.loading = "lazy";
        img.className = "ub-inline-emote";
        parent.appendChild(img);
      } else {
        parent.appendChild(document.createTextNode(token.value));
      }
    });
  }

  var toastTimer = null;
  function toast(message) {
    var box = $("ub-toast");
    box.textContent = message || "";
    box.classList.toggle("ub-show", Boolean(message));
    clearTimeout(toastTimer);
    if (message) toastTimer = setTimeout(function () { box.classList.remove("ub-show"); }, 5000);
  }

  function fmtDate(value) {
    if (!value) return "—";
    var d = new Date(value);
    return isNaN(d) ? "—" : d.toLocaleDateString(LOCALE, { day: "2-digit", month: "long", year: "numeric" });
  }
  function fmtDateTime(value) {
    if (!value) return "—";
    var d = new Date(value);
    return isNaN(d) ? "—" : d.toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function fmtTime(v) { return new Date(v).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }); }
  function fmtDay(v) { return new Date(v).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" }); }

  function post(path, body) {
    return fetch("/" + CHANNEL + "/unban-bureau/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(Object.assign({ _csrf: CSRF }, body)),
    }).then(function (res) {
      return res.json().then(function (data) {
        // Every write endpoint checks the shift, so any of them can be the one that discovers the
        // desk is no longer ours - handle it here rather than in each caller.
        if (res.status === 409 && data && data.error === "shift_taken") shiftLost(data.holder);
        return { status: res.status, data: data };
      });
    });
  }

  function currentCase() { return cases[current]; }

  // --- the shift -----------------------------------------------------------
  // Only one moderator works a channel's desk at a time (db/unbanBureauShiftRepo.js). The server
  // hands out a lease; this keeps it alive while the page is open and hands it back on the way out,
  // so a colleague isn't left waiting out a timeout after someone simply closes the tab.

  var shiftEnded = false;

  // Losing the shift mid-session is rare - it takes a lapsed lease (a suspended laptop, a long
  // network drop) that a colleague then claimed. It is NOT recoverable by retrying: the queue on
  // screen is now being worked by someone else, so the page stops rather than showing a desk whose
  // buttons would all be refused.
  function shiftLost(holder) {
    if (shiftEnded) return;
    shiftEnded = true;
    clearInterval(heartbeatTimer);
    clearInterval(liveTimer);
    clearInterval(spawnTimer);

    var card = el("div", "ub-busy-card");
    card.appendChild(el("div", "ub-busy-worker"));
    card.appendChild(el("div", "ub-busy-title", T.shiftLostTitle));
    card.appendChild(el("div", "ub-busy-name", (holder && holder.displayName) || T.shiftBusySomeone));
    card.appendChild(el("div", "ub-busy-body", T.shiftLostBody));

    var link = document.createElement("a");
    link.className = "ub-busy-btn";
    link.href = "/" + CHANNEL + "/settings";
    link.textContent = T.backToSettings;
    var actions = el("div", "ub-busy-actions");
    actions.appendChild(link);
    card.appendChild(actions);

    var overlay = el("div", "ub-lost-overlay");
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // A failed heartbeat is ignored on purpose: the lease is several beats long, so a single blip
  // doesn't cost the shift, and reacting to one would turn a flaky connection into a lockout.
  function sendHeartbeat() {
    if (shiftEnded) return;
    post("shift.json", {}).catch(function () {});
  }

  // --- the street ----------------------------------------------------------
  // A queue shuffling toward the booth along a fixed polyline, each walker keeping its own personal
  // gap from the one ahead. Purely decorative until the sniper is out, at which point these are the
  // things you can actually shoot.

  var walkers = [];
  var PATH = [
    { x: -50, y: 150 }, { x: 300, y: 150 }, { x: 300, y: 230 },
    { x: 150, y: 250 }, { x: 150, y: 300 }, { x: 430, y: 310 },
  ];
  var PATH_LEN = 0;
  for (var p = 0; p < PATH.length - 1; p += 1) {
    PATH_LEN += Math.hypot(PATH[p + 1].x - PATH[p].x, PATH[p + 1].y - PATH[p].y);
  }

  // The sprites are 20px blown up 3x, so a person occupies ~60 design px of pavement. Personal gaps
  // used to be 4-24px, which packed four overlapping bodies into the space of one and turned the
  // waiting section of the queue into a flickering pile — that overlap, not the frame rate, is what
  // made a crowd look far worse than the walkers out in front.
  function spawnWalker(initialDistance) {
    var queued = 0;
    var tailDistance = PATH_LEN;
    for (var i = 0; i < walkers.length; i += 1) {
      var w = walkers[i];
      if (w.dead || w.inBooth) continue;
      queued += 1;
      if (w.distance < tailDistance) tailDistance = w.distance;
    }
    // Also refuse to spawn on top of whoever is still standing at the entrance: once the queue
    // reaches back this far, new arrivals only stacked at distance 0 in a heap. (The opening seed
    // passes explicit distances, so it lays the starting queue out along the path instead.)
    if (queued > 50) return;
    if (initialDistance == null && queued > 0 && tailDistance < 30) return;
    var node = el("div", "ub-walker");
    var offsetY = Math.floor(Math.random() * 30) - 15;
    node.style.left = Math.round(PATH[0].x) + "px";
    node.style.top = Math.round(PATH[0].y + offsetY) + "px";
    node.style.animationDelay = "-" + Math.random() * 2 + "s";
    street.appendChild(node);
    walkers.push({
      el: node, x: PATH[0].x, y: PATH[0].y, offsetY: offsetY,
      gap: Math.floor(Math.random() * 20) + 30,
      distance: Math.min(initialDistance || 0, PATH_LEN),
      speed: Math.random() * 0.3 + 0.55,
      dead: false, inBooth: false, boothFrames: 0,
      moving: true, gaitFrames: 0, lastLeft: null, lastTop: null, lastZ: null,
    });
  }

  function setWalkerSprite(w, className) {
    if (w.el.classList.contains(className)) return;
    w.el.classList.remove("ub-walker", "ub-idler");
    w.el.classList.add(className);
  }

  // Snapping to WHOLE design pixels (the previous attempt at killing the shimmer) quantized motion
  // far more coarsely than the screen does: at a walking pace under one design px per frame, a
  // walker sat still for several frames and then jumped — reading as worse stutter than the shimmer
  // it fixed. The grid that actually matters is the physical pixel, which after the wrapper's
  // scale() is designPerDevicePx design units wide.
  function snapToPixel(v) {
    return Math.round(v / designPerDevicePx) * designPerDevicePx;
  }

  function placeWalker(w) {
    var left = snapToPixel(w.x);
    var top = snapToPixel(w.y + w.offsetY);
    if (left !== w.lastLeft) { w.el.style.left = left + "px"; w.lastLeft = left; }
    if (top !== w.lastTop) { w.el.style.top = top + "px"; w.lastTop = top; }
  }

  // Walking and idling are two different CSS animations (and the idle one also animates transform,
  // via ub-breathe), so every swap restarts a sprite strip mid-stride. A walker held up in a crowd
  // crosses the "am I moving?" line constantly, which swapped the class every frame or two and made
  // the whole cluster twitch. Movement has to persist for a moment before the sprite follows it.
  var GAIT_START_FRAMES = 8;  // ~0.13s of movement before the walk cycle starts
  var GAIT_STOP_FRAMES = 30;  // ~0.5s of standing still before dropping into idle
  function updateGait(w, moving, dtScale) {
    if (moving === w.moving) { w.gaitFrames = 0; return; }
    w.gaitFrames += dtScale;
    if (w.gaitFrames < (moving ? GAIT_START_FRAMES : GAIT_STOP_FRAMES)) return;
    w.gaitFrames = 0;
    w.moving = moving;
    setWalkerSprite(w, moving ? "ub-walker" : "ub-idler");
  }

  // Movement is normalized to elapsed wall-clock time rather than raw rAF calls: the old version
  // advanced every walker by a fixed amount per frame, so a 144Hz monitor walked the queue 2.4x
  // faster than a 60Hz one, and any frame-time variance (a live poll, a drag, a re-render) directly
  // modulated apparent walking speed. dtScale is "how many 60fps-frames-worth of time actually
  // passed", clamped so a backgrounded-tab pause doesn't teleport everyone forward on return.
  var lastStepTime = null;
  function stepStreet(now) {
    var dtScale = 1;
    if (lastStepTime != null) dtScale = Math.min(Math.max(now - lastStepTime, 0), 100) / (1000 / 60);
    lastStepTime = now;

    for (var i = 0; i < walkers.length; i += 1) {
      var w = walkers[i];
      if (w.dead) continue;

      // The one who was called: walks off to the right and fades out.
      if (w.inBooth) {
        w.x += 0.8 * dtScale;
        w.boothFrames += dtScale;
        w.offsetY *= Math.pow(0.95, dtScale);
        if (w.boothFrames > 80) w.el.style.opacity = Math.max(0, 1 - (w.boothFrames - 80) / 60);
        placeWalker(w);
        if (w.boothFrames > 150) { w.el.remove(); walkers.splice(i, 1); i -= 1; }
        continue;
      }

      // Close on the person ahead rather than switching between full speed and a dead stop: the
      // step is clamped to whatever room is left before this walker's personal gap, so a queue
      // settles smoothly and creeps forward at the pace of its head instead of every member
      // stop-starting each frame. That oscillation was the crowd's real jitter.
      var ahead = PATH_LEN;
      for (var j = i - 1; j >= 0; j -= 1) {
        if (!walkers[j].dead && !walkers[j].inBooth) { ahead = walkers[j].distance - w.distance; break; }
      }
      var room = Math.min(ahead - w.gap, PATH_LEN - w.distance);
      var step = Math.max(0, Math.min(w.speed * dtScale, room));
      w.distance += step;
      updateGait(w, step > 0.02 * dtScale, dtScale);

      var travelled = 0;
      for (var s = 0; s < PATH.length - 1; s += 1) {
        var segLen = Math.hypot(PATH[s + 1].x - PATH[s].x, PATH[s + 1].y - PATH[s].y);
        if (w.distance <= travelled + segLen) {
          var t = (w.distance - travelled) / segLen;
          w.x = PATH[s].x + (PATH[s + 1].x - PATH[s].x) * t;
          w.y = PATH[s].y + (PATH[s + 1].y - PATH[s].y) * t;
          placeWalker(w);
          var z = Math.floor(w.y + w.offsetY);
          if (z !== w.lastZ) { w.el.style.zIndex = z; w.lastZ = z; }
          break;
        }
        travelled += segLen;
      }
    }
    requestAnimationFrame(stepStreet);
  }

  // --- rendering the case --------------------------------------------------

  var SVG_CREATED = '<svg width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M11 2h2v4h7a2 2 0 0 1 2 2v14H2V8a2 2 0 0 1 2-2h7V2Zm9 6H4v4.773l1.507-1.34a3 3 0 0 1 3.986 0l1.843 1.639a1 1 0 0 0 1.328 0l1.843-1.638a3 3 0 0 1 3.986 0L20 12.774V8Zm0 7.449-2.836-2.52a1 1 0 0 0-1.328 0l-1.843 1.637a3 3 0 0 1-3.986 0l-1.843-1.638a1 1 0 0 0-1.328 0L4 15.45V20h16v-4.551Z" clip-rule="evenodd"></path></svg>';
  var SVG_FOLLOW = '<svg width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.964 5.422A5.075 5.075 0 0 0 7.429 4H7C4.239 4 2 6.175 2 8.857v.417a4.79 4.79 0 0 0 1.464 3.434L12 21l8.535-8.292A4.788 4.788 0 0 0 22 9.274v-.417C22 6.175 19.761 4 17 4h-.429a5.076 5.076 0 0 0-3.536 1.423L12 6.429l-1.036-1.007Z" clip-rule="evenodd"></path></svg>';
  var SVG_SUB = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M10.883 2.72c.43-.96 1.803-.96 2.234 0l2.262 5.037 5.525.578c1.052.11 1.477 1.406.69 2.11l-4.127 3.691 1.153 5.395c.22 1.028-.89 1.828-1.808 1.303L12 18.08l-4.812 2.755c-.917.525-2.028-.275-1.808-1.303l1.153-5.395-4.127-3.691c-.786-.704-.362-2 .69-2.11l5.525-.578 2.262-5.037Z"></path></svg>';
  var SVG_RISK = '<svg width="24" height="24" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2 1 21h22L12 2Zm0 5.5 6.9 11.9H5.1L12 7.5ZM11 11h2v5h-2v-5Zm0 6h2v2h-2v-2Z" clip-rule="evenodd"></path></svg>';

  // The badge SVGs are constants with no interpolated data; the label beside each one is a text
  // node, so nothing user-supplied ever reaches innerHTML.
  function infoRow(node, svg, text) {
    node.innerHTML = svg;
    node.appendChild(el("span", null, text));
  }

  function renderCase() {
    var c = currentCase();
    if (!c) { toast(T.allDone); return; }

    currentDecision = null;
    $("ub-visa-reason").value = "";
    $("ub-visa-effective-date").value = "";
    updateEffectiveDatePlaceholder();
    $("ub-visa-card").classList.remove("ub-small-visa");
    Array.prototype.forEach.call(document.querySelectorAll(".ub-imprint"), function (n) { n.remove(); });

    var avatar = c.avatarUrl || BLANK;
    $("ub-uc-avatar").src = avatar;
    $("ub-char-avatar").src = avatar;
    $("ub-char-torso").src = IMG + "torso" + (Math.floor(Math.random() * 4) + 1) + ".png";

    // Each applicant gets a random height, and a random weight on the booth scale — flavour the
    // original has, and the reason the ruler painted on the wall reads as doing something.
    var character = $("ub-character");
    character.style.setProperty("--ub-growth", (0.85 + Math.random() * 0.65).toFixed(2));
    character.style.transform = "translateX(0)";
    $("ub-weight").textContent = Math.floor(Math.random() * 145) + 45;

    $("ub-uc-name").textContent = c.userDisplayName || c.userLogin;
    infoRow($("ub-uc-created"), SVG_CREATED, fmtDate(c.accountCreatedAt));
    infoRow($("ub-uc-follow"), SVG_FOLLOW, c.followedAt ? T.following + " " + fmtDate(c.followedAt) : T.notFollowing);
    // Filled in by loadDossier once the mirrored viewer card arrives; stays "unknown" if it never
    // does, rather than defaulting to the much stronger claim "not subscribed".
    infoRow($("ub-uc-sub"), SVG_SUB, T.subUnknown);

    var appealTextEl = $("ub-appeal-text");
    appealTextEl.textContent = "";
    appendWithEmotes(appealTextEl, c.text || T.noAppealText);
    $("ub-appeal-date").textContent = c.requestedAt ? T.appealSubmitted + " " + fmtDate(c.requestedAt) : "";
    $("ub-visa-name").textContent = "ВИЗА: " + c.userLogin;

    renderVote(c.vote);
    renderSniper(c);
    renderStats();
    scheduleVote(c);

    $("ub-chat-logs").textContent = "";
    $("ub-mod-comments").textContent = "";
    $("ub-actions").textContent = "";
    $("ub-log-msg-count").textContent = "";
    // Cleared before the fetch like the panes above: the sheet must never show the previous
    // applicant's speeches during the round-trip, and most cases have none at all.
    renderOpinions(null);
    // Reset before the fetch, so a scroll landing mid-load can't page the previous applicant's log.
    logState.hasMore = false;
    logState.oldest = null;
    loadDossier(c, null);

    dealPapers();
  }

  // The experts sheet's home, which is exactly where main-gui.png draws it. Measured off the
  // artwork, not eyeballed - the docked card wears the artwork's own pixels, so a pixel out and the
  // seam shows.
  var EXPERTS_HOME = { left: 231, top: 879 };

  // The sheet is painted into the desk artwork, so the drawn copy has to be hidden whenever the card
  // is not sitting on top of it - otherwise picking the card up leaves a second, immovable sheet
  // lying in the pocket. #ub-experts-slot is a patch of empty pocket that covers it.
  function syncExpertsSlot() {
    $("ub-experts-slot").style.display =
      $("ub-experts-card").classList.contains("ub-small-experts") ? "none" : "block";
  }

  // Puts the sheet back in its pocket, square and at exactly the drawn sheet's coordinates.
  function dockExperts() {
    var card = $("ub-experts-card");
    card.classList.add("ub-small-experts");
    card.style.left = EXPERTS_HOME.left + "px";
    card.style.top = EXPERTS_HOME.top + "px";
    card.style.transform = "rotate(0deg)";
    syncExpertsSlot();
  }

  // The notebook's home - same idea as EXPERTS_HOME, measured off the artwork the same way.
  var RULES_HOME = { left: 440, top: 888 };

  // Same idea as syncExpertsSlot(): #ub-rules-slot covers the notebook painted into the desk
  // artwork while the card is off its home.
  function syncRulesSlot() {
    $("ub-rules-slot").style.display =
      $("ub-rules-card").classList.contains("ub-small-rules") ? "none" : "block";
  }

  // Puts the notebook back on the desk, square and at exactly the drawn notebook's coordinates.
  function dockRules() {
    var card = $("ub-rules-card");
    card.classList.add("ub-small-rules");
    card.style.left = RULES_HOME.left + "px";
    card.style.top = RULES_HOME.top + "px";
    card.style.transform = "rotate(0deg)";
    syncRulesSlot();
  }

  // Renders this channel's own posted chat rules (Twitch's chatSettings.rules, mirrored by the
  // bot), or the notebook's empty state. Channel-wide, not per-case - see db/unbanDossierRepo.js's
  // getDossier(). Free-form strings the broadcaster typed, so - like every other Mongo-sourced
  // string on this page - they go through textContent, never innerHTML.
  function renderRules(rules) {
    var body = $("ub-rules-body");
    body.textContent = "";

    var has = Boolean(rules && rules.length);
    $("ub-rules-empty").style.display = has ? "none" : "";
    if (!has) return;

    // NOT re-numbered - see the CSS. Each entry is exactly the line Twitch stored, which may
    // already be a section header or carry the broadcaster's own hand-typed numbering.
    rules.forEach(function (rule) {
      body.appendChild(el("div", "ub-rule-item", rule));
    });
  }

  // Renders the two expert speeches onto the fourth sheet, or its empty state.
  //
  // Every string here goes through textContent, like the rest of this file: these are model-written
  // paragraphs quoting an applicant's own chat lines back, i.e. attacker-influenced text on a page a
  // tier-2 moderator is logged into.
  //
  // `null` is the normal case, not an error - most appeals are never argued. The sheet then shows
  // its empty state and, docked, carries no ink mark, so the moderator can tell at a glance from the
  // desk whether there is anything on it to pick up.
  function renderOpinions(opinions) {
    var body = $("ub-experts-body");
    var card = $("ub-experts-card");
    body.textContent = "";

    var has = Boolean(opinions && opinions.prosecutor && opinions.advocate);
    card.classList.toggle("ub-has-opinions", has);
    $("ub-experts-empty").style.display = has ? "none" : "";
    if (!has) return;

    // The order is the order of the hearing, and it matters: the advocate is answering the
    // accusation directly above it, and the prosecutor's reply answers the defence above that.
    var speeches = [
      { role: T.expertProsecutor, text: opinions.prosecutor.final,
        note: opinions.decision === "rewrite" ? T.expertRewritten : null },
      { role: T.expertAdvocate, text: opinions.advocate.final },
    ];
    if (opinions.prosecutor.rebuttal) {
      speeches.push({ role: T.expertRebuttal, text: opinions.prosecutor.rebuttal, rebuttal: true });
    }

    speeches.forEach(function (speech) {
      if (!speech.text) return;
      var block = document.createElement("div");
      block.className = "ub-speech" + (speech.rebuttal ? " ub-speech-rebuttal" : "");

      var role = document.createElement("div");
      role.className = "ub-speech-role";
      role.textContent = speech.role;
      block.appendChild(role);

      var text = document.createElement("div");
      text.className = "ub-speech-text";
      text.textContent = speech.text;
      block.appendChild(text);

      if (speech.note) {
        var note = document.createElement("div");
        note.className = "ub-speech-note";
        note.textContent = speech.note;
        block.appendChild(note);
      }
      body.appendChild(block);
    });
    body.scrollTop = 0;
  }

  // Slides the five documents up from below the desk, as if printed out.
  function dealPapers() {
    var user = $("ub-user-card");
    var visa = $("ub-visa-card");
    var appeal = $("ub-appeal-card");
    var experts = $("ub-experts-card");
    var rules = $("ub-rules-card");

    Array.prototype.forEach.call(document.querySelectorAll(".ub-paper"), function (n) { n.style.display = "block"; });

    appeal.classList.remove("ub-no-transition");
    appeal.classList.add("ub-small-appeal");
    appeal.style.left = "317px";
    appeal.style.top = "640px";
    appeal.style.transform = "rotate(" + (Math.floor(Math.random() * 10) - 5) + "deg)";

    // The fourth sheet is not printed with the others - it is already lying on the desk in the
    // artwork, so it snaps back into its pocket rather than sliding up from below. Same for the
    // notebook.
    experts.classList.add("ub-no-transition");
    dockExperts();
    experts.style.zIndex = "";

    rules.classList.add("ub-no-transition");
    dockRules();
    rules.style.zIndex = "";

    user.classList.add("ub-no-transition");
    visa.classList.add("ub-no-transition");
    user.style.left = "670px";
    visa.style.left = "1290px";
    user.style.top = "1200px";
    visa.style.top = "1200px";

    setTimeout(function () {
      play("printer");
      user.classList.remove("ub-no-transition");
      visa.classList.remove("ub-no-transition");
      user.style.top = "389px";
      visa.style.top = "440px";
      appeal.style.top = "740px";
      $("ub-chat-logs").scrollTop = $("ub-chat-logs").scrollHeight;
    }, 50);
  }

  function renderStats() {
    $("ub-stat-total").textContent = stats.handled + " / " + cases.length;
    $("ub-stat-approved").textContent = stats.approved;
    $("ub-stat-denied").textContent = stats.denied;
  }

  // --- dossier -------------------------------------------------------------

  // The six below `warn` can only ever come from Twitch's mirror - the bot's own EventSub never
  // recorded a lifting, which is why a page built on our records alone showed 17 bans and no hint
  // that 16 of them were undone.
  var ACTION_LABEL_KEY = {
    ban: "logBanned",
    timeout: "logTimedOut",
    delete: "logDeleted",
    warn: "logWarned",
    unban: "logUnbanned",
    untimeout: "logUntimedOut",
    warnAck: "logWarnAcked",
    unbanRequest: "logUnbanRequested",
    unbanApproved: "logUnbanApproved",
    unbanDenied: "logUnbanDenied",
  };

  // The actions that UNDO a punishment rather than impose one. Used for colour in both panes.
  var LIFTING_ACTIONS = { unban: true, untimeout: true, unbanApproved: true };

  function actionLabel(action) {
    return T[ACTION_LABEL_KEY[action]] || action;
  }

  function modLabel(dossier, modId) {
    var mod = dossier.moderators[modId] || { displayName: modId };
    var node = el("span", "ub-log-user", mod.displayName + (mod.isBot ? " " + T.botMark : ""));
    if (mod.color) node.style.color = mod.color;
    return node;
  }

  // The actor of a `selfActed` row (an acknowledged warning, a past appeal): the applicant, not a
  // moderator. Those rows carry no modId at all, and resolving a null one through the profile cache
  // would print "null" where a name goes.
  function applicantLabel(className) {
    var c = currentCase();
    return el("span", className, (c && (c.userDisplayName || c.userLogin)) || "—");
  }

  function renderLog(dossier, prepend) {
    var container = $("ub-chat-logs");
    var fragment = document.createDocumentFragment();
    var lastDay = null;

    // Prepending older messages pushes everything down by the height of what was added, so the
    // line the moderator was reading would jump off screen. Measured before the insert and
    // corrected after, which is what makes the auto-load feel like the list simply got longer
    // upwards instead of teleporting.
    var heightBefore = container.scrollHeight;
    var scrollBefore = container.scrollTop;

    dossier.log.entries.forEach(function (entry) {
      var day = fmtDay(entry.timestamp);
      if (day !== lastDay) { fragment.appendChild(el("div", "ub-log-day", day)); lastDay = day; }

      // Every action row in this log used to be red-tinted, which was fine while the only rows were
      // punishments. It is not fine for a lifting: "vlad_261 снял бан" drawn in the ban colour reads
      // as another strike against the applicant, which is the exact misreading these rows exist to
      // prevent. The applicant's own entries are neutral for the same reason.
      var rowClass = "ub-log-message";
      if (entry.type === "action") {
        rowClass = "ub-log-modaction";
        if (LIFTING_ACTIONS[entry.action]) rowClass += " ub-log-lifted";
        else if (entry.selfActed) rowClass += " ub-log-selfacted";
      }
      var row = el("div", rowClass);
      row.appendChild(el("span", "ub-log-time", fmtTime(entry.timestamp)));

      if (entry.type === "action") {
        var body = el("span", "ub-log-modaction-text");
        body.appendChild(entry.selfActed ? applicantLabel("ub-log-user") : modLabel(dossier, entry.modId));
        body.appendChild(document.createTextNode(" " + actionLabel(entry.action)));
        if (entry.reason) body.appendChild(document.createTextNode(" — " + entry.reason));
        row.appendChild(body);
      } else {
        var textSpan = el("span", null, null);
        appendWithEmotes(textSpan, entry.text);
        row.appendChild(textSpan);
        if (entry.probableCause) {
          row.classList.add("ub-log-flagged");
          row.appendChild(el("span", "ub-log-badge", T.probableCause));
        }
      }
      fragment.appendChild(row);
    });

    if (prepend) container.insertBefore(fragment, container.firstChild);
    else container.appendChild(fragment);

    if (!container.childNodes.length) container.appendChild(el("div", "ub-log-system", T.logEmpty));

    if (prepend) container.scrollTop = scrollBefore + (container.scrollHeight - heightBefore);

    // What the scroll handler needs to fetch the next page back. There is no button any more -
    // scrolling to the top of the pane is the trigger.
    logState.hasMore = Boolean(dossier.log.hasMore);
    logState.oldest = dossier.log.oldestTimestamp || null;
  }

  // Auto-loads the previous page when the moderator reaches the top of the log. Bound once, to the
  // pane rather than to any row, so it survives every re-render.
  //
  // The guard is `logState.loading`: a scroll event fires many times per gesture, and without it a
  // single flick would launch a dozen identical requests and prepend each of them.
  var logState = { hasMore: false, oldest: null, loading: false };
  var LOG_LOAD_TRIGGER_PX = 60;
  var lastDossier = null; // re-render target for the actions tab's "hide bots" toggle

  $("ub-chat-logs").addEventListener("scroll", function () {
    if (logState.loading || !logState.hasMore || !logState.oldest) return;
    if (this.scrollTop > LOG_LOAD_TRIGGER_PX) return;
    var c = currentCase();
    if (c) loadDossier(c, logState.oldest);
  });

  // Twitch's OWN moderator comments on this user - the notes moderators leave in the viewer card,
  // mirrored onto the case by the bot (there is no Helix endpoint for them). Not to be confused
  // with a ban's reason, which explains one action and still renders inline in the chat log.
  //
  // Author name and colour come from Twitch with the comment, so unlike every other row on this
  // page they need no profile lookup - and unlike the mod-action rows there is no bot to mark,
  // since a comment is always written by a person.
  function renderModComments(dossier) {
    var container = $("ub-mod-comments");
    container.textContent = "";

    // Half of this tab - and the whole of the card's shared-ban note - can only ever be filled on a
    // channel that joined Twitch's ban sharing. Without this line an empty list reads as "no other
    // channel has anything on them", which is a far stronger claim than "we were never allowed to
    // look". It goes here rather than in the risk row because that row has three lines to spend and
    // this notice would occupy one of them on every single applicant of an opted-out channel.
    var sharing = dossier.banSharing;
    if (sharing && (!sharing.enabled || !sharing.commentsShared)) {
      container.appendChild(el("div", "ub-log-system", T.sharingOff));
    }

    if (!dossier.modComments.length) {
      container.appendChild(el("div", "ub-log-system", T.commentsEmpty));
      return;
    }
    dossier.modComments.forEach(function (comment) {
      var box = el("div", "ub-mod-comment");
      var header = el("div", "ub-mod-comment-header");

      var author = el("span", "ub-mod-comment-author", comment.authorDisplayName || "—");
      if (comment.authorColor) author.style.color = comment.authorColor;
      header.appendChild(author);

      // A comment that reached this channel through Twitch's ban-sharing was written by someone
      // else's moderator about behaviour in someone else's chat. Labelling it is the difference
      // between evidence and a false accusation.
      if (comment.shared) {
        header.appendChild(el(
          "span",
          "ub-mod-comment-shared",
          T.commentShared.replace("{{channel}}", comment.sourceChannelLogin || "?")
        ));
      }

      header.appendChild(el("span", "ub-mod-comment-time", fmtDateTime(comment.timestamp)));
      box.appendChild(header);
      box.appendChild(el("div", "ub-mod-comment-text", comment.text));
      container.appendChild(box);
    });
  }

  // Twitch's risk read, shown ONLY when it says something - a ban-evasion likelihood above
  // "unlikely", an enforcement treatment other than none, or another channel's shared ban.
  //
  // Silence rather than "риск: обычный" on purpose. The card has room for three lines above the
  // counters, and a row that is present for every applicant saying "nothing unusual" costs one of
  // them permanently while carrying no information; a row that appears only when it matters is
  // read. The trade is that "no row" also covers "no mirror at all" - which is the same thing the
  // rest of the card does when Twitch is unreachable.
  function renderRisk(risk, counts) {
    var row = $("ub-uc-risk");
    var notes = [];
    if (risk) {
      if (risk.banEvasion && risk.banEvasion !== "UNLIKELY") {
        notes.push(T["riskEvasion" + risk.banEvasion] || T.riskEvasionPOSSIBLE);
      }
      // A second, independent evaluation Twitch answers in the same field. Same silence rule: only
      // ever shown above "unlikely".
      if (risk.harassment && risk.harassment !== "UNLIKELY") {
        notes.push(T["riskHarassment" + risk.harassment] || T.riskHarassmentPOSSIBLE);
      }
      if (risk.treatment && risk.treatment !== "NONE") {
        notes.push(T["riskTreatment" + risk.treatment] || risk.treatment);
      }
      if (risk.sharedBanChannels && risk.sharedBanChannels.length) {
        notes.push(T.riskSharedBans.replace("{{count}}", risk.sharedBanChannels.length));
      }
    }
    // Recidivism through THIS process, which is the fact an amnesty decision turns on most directly
    // and which our own records cannot supply (they only go back to when the bot started mirroring
    // the queue - days, against Twitch's years). Deliberately the RESOLVED counts only: the count of
    // requests filed includes the one being reviewed right now, so it would read as "has appealed
    // before" for a first-time applicant.
    if (counts && counts.source === "twitch") {
      if (counts.unbanApproved) {
        notes.push(T.riskPriorApproved.replace("{{count}}", counts.unbanApproved));
      }
      if (counts.unbanDenied) {
        notes.push(T.riskPriorDenied.replace("{{count}}", counts.unbanDenied));
      }
    }
    row.style.display = notes.length ? "flex" : "none";
    // Tightens the whole header block so four lines fit where three do - see the CSS.
    $("ub-user-card").classList.toggle("ub-has-risk", notes.length > 0);
    if (!notes.length) return;
    var text = notes.join(" · ");
    infoRow(row, SVG_RISK, text);
    // The row is clipped to one line (see the CSS); the title is where the rest lives.
    row.title = text;
  }

  // The punishments tab: every ban/timeout/warning against this user, oldest first (newest at the
  // bottom) - same order as the chat log, rather than fighting it.
  //
  // The row's wording is split by source on purpose. The VERB comes from `action`, written in the
  // viewer's own language; the tail (`detail` - duration and the moderator's stated reason) is
  // Twitch's own localized string, because Twitch exposes those two facts nowhere else. A row the
  // bot itself recorded has a bare reason in `detail` and its duration in `durationMs`.
  function renderActions(dossier) {
    lastDossier = dossier;
    var container = $("ub-actions");
    container.textContent = "";

    var hideBots = $("ub-hide-bots").checked;
    var actions = dossier.actions.filter(function (action) {
      var mod = dossier.moderators[action.modId];
      return !(hideBots && mod && mod.isBot);
    });

    if (!actions.length) {
      container.appendChild(el("div", "ub-log-system", T.actionsEmpty));
      return;
    }

    actions.forEach(function (action) {
      var row = el("div", "ub-action-row");

      var head = el("div", "ub-action-head");
      head.appendChild(el("span", "ub-action-time", fmtDateTime(action.timestamp)));
      head.appendChild(el("span", "ub-action-verb " + "ub-action-" + (action.action || "ban"),
        actionLabel(action.action)));
      if (action.selfActed) {
        head.appendChild(applicantLabel("ub-action-mod"));
      } else if (action.modId || action.modDisplayName) {
        head.appendChild(actionModLabel(dossier, action));
      }
      row.appendChild(head);

      // Our own rows carry a machine-readable duration; Twitch's carry it inside `detail`.
      var detail = action.detail || "";
      if (action.source === "bot" && action.durationMs) {
        detail = fmtDuration(action.durationMs) + (detail ? " — " + detail : "");
      }
      if (detail) row.appendChild(el("div", "ub-action-detail", detail));

      // What became of this punishment. Folded in by the repo rather than listed as its own row, so
      // "issued for two weeks" and "lifted after a minute" are read together instead of paired by eye
      // across a list where 49 timeouts and 16 liftings interleave.
      if (action.followUp) row.appendChild(followUpLine(dossier, action.followUp));

      // Only rows we can actually answer for get the affordance - see buildActionList's note on
      // why `contextId` is absent more often than not.
      if (action.contextId) {
        row.classList.add("ub-action-has-context");
        row.appendChild(el("div", "ub-action-hint", T.contextHint));
        var popup = el("div", "ub-action-context");
        row.appendChild(popup);
        attachContext(row, popup, action.contextId);
      }

      container.appendChild(row);
    });
  }

  // "↳ снял бан — vlad_261 · 16.06.26, 21:13 · через 1 мин". Built out of nodes rather than one
  // string so the moderator's own chat colour survives, and green (or neutral, for the applicant's
  // own acknowledgement) so it never reads as a second punishment.
  function followUpLine(dossier, followUp) {
    var line = el("div", "ub-action-followup" +
      (LIFTING_ACTIONS[followUp.action] ? " ub-action-followup-lifted" : ""));
    line.appendChild(el("span", "ub-action-followup-mark", "↳"));
    line.appendChild(el("span", "ub-action-followup-verb", actionLabel(followUp.action)));
    line.appendChild(followUp.selfActed
      ? applicantLabel("ub-action-followup-mod")
      : actionModLabel(dossier, followUp, "ub-action-followup-mod"));
    line.appendChild(el("span", "ub-action-followup-time", fmtDateTime(followUp.timestamp)));
    // Only ever "after N" - never an absolute claim about how long the punishment was meant to last,
    // which lives in `detail` above in Twitch's own words.
    if (followUp.afterMs != null && followUp.afterMs >= 0) {
      line.appendChild(el("span", "ub-action-followup-after",
        T.actionLiftedAfter.replace("{{after}}", fmtDuration(followUp.afterMs))));
    }
    return line;
  }

  function actionModLabel(dossier, action, className) {
    var profile = dossier.moderators[action.modId] || {};
    var name = action.modDisplayName || profile.displayName || action.modId;
    var node = el("span", className || "ub-action-mod", name + (profile.isBot ? " " + T.botMark : ""));
    if (profile.color) node.style.color = profile.color;
    return node;
  }

  // Units come from the locale: this used to hard-code "s"/"m"/"h"/"d", which was easy to overlook
  // while it only appeared on the handful of rows the bot itself recorded, and reads as a bug now
  // that every lifted punishment carries a "через 54s" beside it.
  function fmtDuration(ms) {
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + T.unitSec;
    if (seconds < 3600) return Math.round(seconds / 60) + T.unitMin;
    if (seconds < 86400) return Math.round(seconds / 3600) + T.unitHour;
    return Math.round(seconds / 86400) + T.unitDay;
  }

  // Lazily fills the "last messages before this action" popup, once, on first hover. The endpoint
  // is the mod-statistics page's own (/:channel/mod-action-context.json) - same tier-2 gate, same
  // five-message window, so this reuses it rather than growing a second copy of that query.
  function attachContext(row, popup, contextId) {
    var loaded = false;
    row.addEventListener("mouseenter", function () {
      // The list scrolls and clips, so a popup hung below a row near the bottom would be cut in
      // half. Decided per hover rather than once at render, because the row's position inside the
      // pane changes as the moderator scrolls.
      var pane = $("ub-actions");
      var below = row.offsetTop + row.offsetHeight - pane.scrollTop;
      var flip = below > pane.clientHeight / 2;
      popup.style.top = flip ? "auto" : "100%";
      popup.style.bottom = flip ? "100%" : "auto";
      popup.style.marginTop = flip ? "0" : "2px";
      popup.style.marginBottom = flip ? "2px" : "0";

      if (loaded) return;
      loaded = true;
      popup.textContent = T.contextLoading;
      fetch("/" + CHANNEL + "/mod-action-context.json?id=" + encodeURIComponent(contextId), {
        headers: { Accept: "application/json" },
      })
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          popup.textContent = "";
          if (!payload.available || !payload.messages || !payload.messages.length) {
            popup.appendChild(el("div", "ub-log-system", T.contextEmpty));
            return;
          }
          payload.messages.forEach(function (message) {
            var line = el("div", "ub-context-line" + (message.flagged ? " ub-log-flagged" : ""));
            line.appendChild(el("span", "ub-log-time", fmtTime(message.timestamp)));
            line.appendChild(el("span", null, message.message));
            popup.appendChild(line);
          });
        })
        .catch(function () {
          popup.textContent = "";
          popup.appendChild(el("div", "ub-log-system", T.loadError));
          loaded = false; // a failed fetch may as well be retried on the next hover
        });
    });
  }

  // "17" normally, "1000+" when the user's history outran the page the bot asked Twitch for.
  function fmtCount(value, truncated) {
    return truncated ? (value || 0) + "+" : String(value || 0);
  }

  // Caps at "9999+" - a five-figure exact count would just crowd the label, and getLogPage's own
  // number is already a best-effort lower bound (see its messageCount comment), not a hard total.
  function fmtMessageCount(value) {
    var n = value || 0;
    return (n > 9999 ? "9999+" : String(n)) + " " + T.messages.toLowerCase();
  }

  // Twitch's counters count punishments ISSUED and say nothing about the ones the moderators then
  // undid - and "17 bans, 16 of them lifted" is not the same applicant as 17 that stood. The
  // follow-up count goes into the box's tooltip rather than beside the number: the card is a pixel
  // port with room for exactly five values, and the tooltip is already where the counts explain
  // themselves. The rows themselves are visible without hovering anything, in the punishments tab.
  function annotateCount(valueId, count, template, base) {
    var box = $(valueId).parentNode;
    box.title = count ? base + " · " + template.replace("{{count}}", count) : base;
  }

  // Three states, not a boolean: "not subscribed" is only true of a channel that SELLS
  // subscriptions - on an unaffiliated channel nobody can subscribe, and saying "not subscribed"
  // there reads as a mark against the applicant for something impossible.
  function subscriptionLabel(subscription) {
    if (!subscription) return T.subUnknown;
    if (subscription.state === "unavailable") return T.subUnavailable;
    if (subscription.state !== "subscribed") return T.subNone;
    var label = subscription.tier ? T.subTier.replace("{{tier}}", subscription.tier) : T.subActive;
    return subscription.prime ? label + " " + T.subPrime : label;
  }

  function loadDossier(c, before) {
    var url = "/" + CHANNEL + "/unban-bureau/dossier.json?id=" + encodeURIComponent(c._id) +
      (before ? "&before=" + encodeURIComponent(before) : "");
    logState.loading = true;
    if (before) showLogSpinner(true);
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (res) { return res.json(); })
      .then(function (payload) {
        if (!payload.ok) throw new Error(payload.error || "load_failed");
        var d = payload.dossier;
        // A "load previous" page only extends the log — the counts, the last ban and the comments
        // tab are whole-history figures that don't change with paging.
        if (!before) {
          $("ub-uc-bans").textContent = fmtCount(d.counts.ban, d.counts.truncated);
          $("ub-uc-timeouts").textContent = fmtCount(d.counts.timeout, d.counts.truncated);
          $("ub-uc-warns").textContent = fmtCount(d.counts.warn, d.counts.truncated);
          // Two very different numbers wear the same label: Twitch's lifetime totals for this
          // channel, or - if the bot couldn't reach Twitch - only what it witnessed since joining,
          // which for an old account is a small fraction. A moderator judging an appeal has to be
          // able to tell which one they're looking at.
          infoRow($("ub-uc-sub"), SVG_SUB, subscriptionLabel(d.subscription));
          var countsNote = d.counts.source === "twitch" ? T.countsFromTwitch : T.countsFromBot;
          Array.prototype.forEach.call(
            document.querySelectorAll("#ub-uc-ban-stats .ub-stat-box"),
            function (box) { box.title = countsNote; }
          );
          // What became of those punishments afterwards. Absent from the bot's own records entirely
          // (it never recorded a lifting), so these stay silent unless Twitch supplied them.
          annotateCount("ub-uc-bans", d.counts.unban, T.countsLifted, countsNote);
          annotateCount("ub-uc-timeouts", d.counts.untimeout, T.countsLifted, countsNote);
          annotateCount("ub-uc-warns", d.counts.warnAck, T.countsAcked, countsNote);
          if (d.lastBan) {
            var mod = d.moderators[d.lastBan.modId] || {};
            // Twitch ships the moderator's name with the strike; our own rows have only an id to
            // resolve. The bot mark matters either way: the counts above exclude bot actions while
            // this deliberately doesn't, so an unmarked bot name over "Bans: 0" would read as a bug.
            var name = d.lastBan.modDisplayName || mod.displayName || d.lastBan.modId;
            $("ub-uc-banned-by").textContent = name + (mod.isBot ? " " + T.botMark : "");
            $("ub-uc-banned-at").textContent = fmtDateTime(d.lastBan.timestamp);
          } else {
            $("ub-uc-banned-by").textContent = "—";
            $("ub-uc-banned-at").textContent = "—";
          }
          renderRisk(d.risk, d.counts);
          renderModComments(d);
          renderActions(d);
          // Channel-wide, not per-case - the same list on every applicant from this channel - but
          // reloaded with every dossier anyway rather than cached, same as everything else here.
          renderRules(d.channelRules);
          // Sent only on a first load, not on a ?before= log page - the route omits the field
          // entirely there rather than re-sending an unchanged sheet with every scroll-back.
          renderOpinions(payload.opinions || null);
          $("ub-log-msg-count").textContent = fmtMessageCount(d.log.messageCount);
          // Newest is at the bottom now, like the log - if the actions tab is what the moderator
          // was already looking at (the active tab carries over between cases), land on the newest
          // row rather than the oldest one from years back.
          if ($("ub-actions").style.display !== "none") {
            $("ub-actions").scrollTop = $("ub-actions").scrollHeight;
          }
        }
        showLogSpinner(false);
        renderLog(d, Boolean(before));
        if (!before) $("ub-chat-logs").scrollTop = $("ub-chat-logs").scrollHeight;
        logState.loading = false;
      })
      .catch(function () {
        showLogSpinner(false);
        // Left unlocked on purpose: the next scroll retries, which is the only way back for a
        // dropped page now that there is no button to press.
        logState.loading = false;
        toast(T.loadError);
      });
  }

  // A one-line placeholder pinned to the top of the log while an older page is on its way. Doubles
  // as the only feedback that scrolling to the top did anything at all.
  function showLogSpinner(on) {
    var container = $("ub-chat-logs");
    var existing = container.querySelector(".ub-log-loading");
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    container.insertBefore(el("div", "ub-log-loading", T.contextLoading), container.firstChild);
  }

  // --- vote + sniper readout -----------------------------------------------

  function renderVote(vote) {
    var bar = $("ub-vote-bar");
    if (!vote || !vote.status) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    $("ub-vote-yea-count").textContent = vote.approve || 0;
    $("ub-vote-nay-count").textContent = vote.deny || 0;
    if (vote.status === "requested") toast(T.voteQueued);
    else if (vote.status === "closed") toast(T.voteClosed);
  }

  function renderSniper(c) {
    var shot = c && c.sniper;
    if (!shot || !shot.fired || announcedShots[c._id + ":" + shot.firedAt]) return;
    announcedShots[c._id + ":" + shot.firedAt] = true;
    toast(shot.success
      ? T.sniperHit.replace("{{target}}", "@" + shot.targetLogin)
      : T.sniperNoTarget);
  }

  // --- dragging ------------------------------------------------------------
  // The three papers are moved by the pointer directly. `dragOffset` is where inside the paper it
  // was grabbed, so the paper doesn't jump to centre itself on the cursor.

  var dragging = null;
  var dragOffset = { x: 0, y: 0 };
  // The paper currently in hand must always render above the other two, including ones that were
  // dragged more recently in wall-clock terms but released earlier. A monotonic counter (not
  // Date.now(), which wraps every ~100s of absolute epoch time and can hand out a SMALLER value to
  // a paper picked up later) guarantees "most recently grabbed" always wins.
  var topZCounter = 0;
  // Whether a desk-docked paper is allowed to auto-shrink back down while the cursor is still over
  // its home zone. Picking one up off the desk un-shrinks it immediately (see the mousedown handler
  // below); without this guard, the very next mousemove would see the cursor still inside the zone
  // it was just grabbed from and shrink it right back, producing a big-then-small flicker.
  // Keyed by paper id, because both the appeal note and the experts sheet dock this way and a
  // single shared flag would let one card's pickup disarm the other's.
  var shrinkArmed = {};

  // The three papers that live docked on the desk rather than being held in front of the moderator.
  // `small`/`big` are the grab offsets used while the card is in each state - a card that changes
  // size under the cursor has to be re-centred on it or it jumps out from under the pointer.
  var DOCKED = {
    "ub-appeal-card": { cls: "ub-small-appeal", zone: "ub-appeal-zone", small: { x: 60, y: 60 }, big: { x: 150, y: 150 } },
    "ub-experts-card": { cls: "ub-small-experts", zone: "ub-experts-zone", small: { x: 31, y: 57 }, big: { x: 250, y: 120 } },
    "ub-rules-card": { cls: "ub-small-rules", zone: "ub-rules-zone", small: { x: 41, y: 55 }, big: { x: 230, y: 140 } },
  };

  function zoneRect(id) {
    var style = window.getComputedStyle($(id));
    var left = parseInt(style.left, 10);
    var top = parseInt(style.top, 10);
    return { left: left, top: top, right: left + parseInt(style.width, 10), bottom: top + parseInt(style.height, 10) };
  }
  function inZone(point, id) {
    var z = zoneRect(id);
    return point.x >= z.left && point.x <= z.right && point.y >= z.top && point.y <= z.bottom;
  }

  Array.prototype.forEach.call(document.querySelectorAll(".ub-draggable"), function (paper) {
    paper.addEventListener("mousedown", function (event) {
      var target = event.target;
      // Anything interactive inside a paper keeps its own click.
      if (target.tagName.toLowerCase() === "textarea") return;
      if (target.id === "ub-visa-effective-date") return;
      if (target.classList.contains("ub-tab")) return;
      // Let the scroll bars of the log/appeal/experts/rules panes work instead of starting a drag.
      if ((target.id === "ub-chat-logs" || target.id === "ub-mod-comments" ||
           target.id === "ub-actions" || target.id === "ub-appeal-text" ||
           target.id === "ub-experts-body" || target.id === "ub-rules-body") &&
          event.offsetX > target.clientWidth - 15) return;

      dragging = paper;
      paper.classList.add("ub-no-transition");
      play("dragStart");
      topZCounter += 1;
      paper.style.zIndex = String(10000 + topZCounter);

      var point = toStage(event);
      var rect = paper.getBoundingClientRect();

      // Picking a docked paper up off the desk un-shrinks it, so grab it by its middle.
      var docked = DOCKED[paper.id];
      if (docked && paper.classList.contains(docked.cls)) {
        paper.classList.remove(docked.cls);
        // The experts sheet snaps rather than animating (dealPapers() leaves ub-no-transition on
        // it), but the class is re-added on every mousedown above anyway - so un-shrinking here is
        // instant for both papers regardless.
        dragOffset = docked.big;
        paper.style.left = point.x - dragOffset.x + "px";
        paper.style.top = point.y - dragOffset.y + "px";
        shrinkArmed[paper.id] = false;
        // The pocket is now empty - the drawn sheet/notebook has to go with the card it just became.
        if (paper.id === "ub-experts-card") syncExpertsSlot();
        if (paper.id === "ub-rules-card") syncRulesSlot();
      } else {
        dragOffset = { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
        if (docked) shrinkArmed[paper.id] = true;
      }
      event.preventDefault();
    });
    paper.ondragstart = function () { return false; };
  });

  document.addEventListener("mousemove", function (event) {
    if (!dragging) return;
    var point = toStage(event);
    dragging.style.left = point.x - dragOffset.x + "px";
    dragging.style.top = point.y - dragOffset.y + "px";

    // The papers shrink while held over their drop zone, which is the whole feedback that the
    // zone is live — there is no highlight on the artwork itself.
    var shrink = dragging.id === "ub-visa-card"
      ? { cls: "ub-small-visa", zone: "ub-window-zone", small: { x: 65, y: 70 }, big: { x: 140, y: 150 } }
      : DOCKED[dragging.id];
    if (!shrink) return;

    var inside = inZone(point, shrink.zone);

    // See shrinkArmed's declaration: suppress a docked paper's shrink-preview until the cursor has
    // actually left its home zone once since pickup, or grabbing it in place would flicker.
    if (DOCKED[dragging.id]) {
      if (!inside) shrinkArmed[dragging.id] = true;
      if (!shrinkArmed[dragging.id]) return;
    }

    var isSmall = dragging.classList.contains(shrink.cls);
    if (inside === isSmall) return;

    dragging.classList.toggle(shrink.cls, inside);
    dragOffset = inside ? shrink.small : shrink.big;
    // Docked papers lie square on the desk; only the appeal note is dealt at a random angle, and
    // that tilt has to come off as it settles into its slot.
    if (inside && DOCKED[dragging.id]) dragging.style.transform = "rotate(0deg)";
    dragging.style.left = point.x - dragOffset.x + "px";
    dragging.style.top = point.y - dragOffset.y + "px";
    // Held over its own pocket the card is small again, so the drawn sheet/notebook underneath
    // must stay hidden - without this the shrink-preview shows two copies stacked.
    if (dragging.id === "ub-experts-card") syncExpertsSlot();
    if (dragging.id === "ub-rules-card") syncRulesSlot();
  });

  document.addEventListener("mouseup", function (event) {
    if (!dragging) return;
    var paper = dragging;
    dragging = null;
    play("dragStop");

    // Dropped anywhere on the desktop - the same forgiving area the appeal note uses, they share one
    // zone - the experts sheet and the notebook magnet back into their pocket rather than being left
    // wherever the cursor happened to be. They are the only papers with a drawn home to line up
    // with: a few pixels out and the card no longer covers the shape painted into the artwork,
    // which is exactly the seam this whole arrangement exists to hide. Note the shrink preview
    // during the drag is now rare (the zone is large enough that the cursor may never leave it, and
    // shrinkArmed suppresses the preview until it does) - the snap on release is what tells the
    // moderator it landed.
    if (paper.id === "ub-experts-card") {
      if (inZone(toStage(event), "ub-experts-zone")) dockExperts();
      else syncExpertsSlot();
      return;
    }
    if (paper.id === "ub-rules-card") {
      if (inZone(toStage(event), "ub-rules-zone")) dockRules();
      else syncRulesSlot();
      return;
    }

    // Handing the visa back through the window is what submits the verdict — but only once it
    // carries a stamp, which is the entire point of the stamp machine.
    if (paper.id !== "ub-visa-card" || isProcessing) return;
    if (!inZone(toStage(event), "ub-window-zone")) return;
    if (!currentDecision) { toast(T.needStamp); return; }
    submitDecision();
  });

  // --- actions -------------------------------------------------------------

  function submitDecision() {
    var c = currentCase();
    if (!c) return;
    isProcessing = true;
    play("spit");

    var decision = currentDecision;
    $("ub-character").style.transform = "translateX(-1920px)";
    Array.prototype.forEach.call(document.querySelectorAll(".ub-paper"), function (n) { n.style.display = "none"; });
    // With the papers cleared the desk goes back to its painted state, so the empty-pocket patches
    // come off too - otherwise a case stamped while the sheet/notebook was in hand leaves a hole in
    // the artwork until the next case deals.
    $("ub-experts-slot").style.display = "none";
    $("ub-rules-slot").style.display = "none";

    // Only meaningful for an approval - see #ub-visa-effective's own comment in the view. Sent as
    // the native date input's raw "YYYY-MM-DD" value; the server is what actually validates it.
    var effectiveAt = decision === "approved" ? $("ub-visa-effective-date").value : "";

    post("decide.json", {
      id: c._id,
      decision: decision,
      resolutionText: $("ub-visa-reason").value,
      effectiveAt: effectiveAt,
    })
      .then(function (result) {
        if (result.status === 409) { toast(T.alreadyDecided); }
        else if (!result.data.ok) { toast(T.failed); }
        else {
          c.resolution = result.data.resolution;
          stats.handled += 1;
          if (decision === "approved") stats.approved += 1; else stats.denied += 1;
          renderStats();
          toast(c.resolution.effectiveAt
            ? T.approveScheduled.replace("{{date}}", fmtDate(c.resolution.effectiveAt))
            : T.queued);
        }
        advance();
      })
      .catch(function () { toast(T.failed); isProcessing = false; });
  }

  // Calls the next applicant: the person at the head of the street queue peels off toward the
  // booth, and the next case is dealt.
  function advance() {
    var alive = walkers.filter(function (w) { return !w.dead && !w.inBooth; });
    alive.sort(function (a, b) { return b.distance - a.distance; });
    if (alive[0]) {
      alive[0].inBooth = true;
      setWalkerSprite(alive[0], "ub-walker");
      alive[0].el.style.zIndex = 1000;
    }

    isProcessing = false;
    if (current + 1 >= cases.length) { toast(T.allDone); return; }
    current += 1;
    renderCase();
  }

  $("ub-loudspeaker").addEventListener("click", function () {
    if (isProcessing) return;
    play("speaker");
    advance();
  });

  // --- stamp machine -------------------------------------------------------

  var machineOpen = false;
  $("ub-stamp-toggle").addEventListener("click", function () {
    machineOpen = !machineOpen;
    $("ub-stamp-machine").classList.toggle("ub-open", machineOpen);
    this.style.opacity = machineOpen ? "0" : "1";
    play("stampUp");
  });

  $("ub-stamp-machine").addEventListener("mousedown", function (event) {
    // Clicking the machine's body (not a button) puts it away again.
    if (!machineOpen || event.target.closest(".ub-stamp-btn")) return;
    $("ub-stamp-toggle").click();
  });

  Array.prototype.forEach.call(document.querySelectorAll(".ub-stamp-btn"), function (btn) {
    btn.addEventListener("mousedown", function () {
      play("stampDown");
      currentDecision = btn.dataset.decision;

      // The machine also throws the visa onto the pad it stamped it on, so the two decisions land
      // the card in visibly different places.
      var visa = $("ub-visa-card");
      visa.classList.add("ub-no-transition");
      visa.style.left = (currentDecision === "approved" ? 1267 : 1530) + "px";
      visa.style.top = (currentDecision === "approved" ? 395 : 420) + "px";

      Array.prototype.forEach.call(document.querySelectorAll(".ub-imprint"), function (n) { n.remove(); });
      var imprint = document.createElement("img");
      imprint.src = IMG + (currentDecision === "approved" ? "stamp-approved.png" : "stamp-denied.png");
      imprint.className = "ub-imprint";
      imprint.style.left = "187px";
      imprint.style.top = "109px";
      imprint.style.transform = "translate(-50%, -50%) rotate(" + (Math.floor(Math.random() * 20) - 10) + "deg)";
      visa.appendChild(imprint);
    });
  });

  // --- the sniper ----------------------------------------------------------
  // Manual, exactly like the original: arm the rifle, then click a specific person on the street.
  // The click both kills that sprite locally and asks the bot to punish a real chatter.

  var sniperArmed = false;
  function setSniper(on) {
    if (on === sniperArmed) return;
    sniperArmed = on;
    wrapper.classList.toggle("ub-sniper", on);
    // There's no dedicated pickup/holster foley yet, so the stamp machine's own mechanical clicks
    // stand in — closer to a bolt-action sound than silence. Grouped under the "Shoot" slider since
    // it's the only weapon-related volume control on the settings panel.
    play(on ? "sniperArm" : "sniperDisarm");
    $("ub-awp").classList.toggle("ub-armed", on);
    toast(on ? T.sniperArmed : T.sniperDisarmed);
  }
  $("ub-awp").addEventListener("click", function () { setSniper(!sniperArmed); });
  wrapper.addEventListener("contextmenu", function (event) {
    if (!sniperArmed) return;
    event.preventDefault();
    setSniper(false);
  });

  street.addEventListener("click", function (event) {
    if (!sniperArmed) return;
    play("shoot");

    var point = toStage(event);
    for (var i = walkers.length - 1; i >= 0; i -= 1) {
      var w = walkers[i];
      if (w.dead || w.inBooth) continue;
      if (Math.hypot(w.x - point.x, w.y + w.offsetY - point.y) >= 30) continue;
      w.dead = true;
      w.el.classList.remove("ub-walker", "ub-idler");
      w.el.classList.add("ub-dead");
      w.el.style.zIndex = 1;
      // Bodies linger a while, then fade — the original leaves them on the pavement.
      setTimeout(function (node) {
        node.style.transition = "opacity 2s";
        node.style.opacity = "0";
        setTimeout(function () { node.remove(); }, 2000);
      }, 15000, w.el);
      break;
    }

    var c = currentCase();
    post("sniper.json", { id: c ? c._id : "" })
      .then(function (result) {
        if (result.data && result.data.ok) toast(T.sniperQueued);
        else toast(result.status === 409 ? T.sniperNoTarget : T.failed);
      })
      .catch(function () { toast(T.failed); });
  });

  // --- chat vote -----------------------------------------------------------

  // Chat votes on whatever appeal is at the window: the vote opens when a case is shown and the
  // bot closes it the moment a verdict is stamped (routes/unbanBureau.js's decide.json asks it to).
  // There is no button - it is not a thing the moderator decides any more.
  //
  // Debounced, and once per case: flipping through a queue would otherwise make the bot post a
  // vote prompt in chat for every case the moderator merely passed over.
  var voteTimer = null;
  var voteRequested = {};

  function scheduleVote(c) {
    clearTimeout(voteTimer);
    if (!c || voteRequested[c._id]) return;
    voteTimer = setTimeout(function () {
      // Re-check: the moderator may have moved on during the debounce.
      var shown = currentCase();
      if (!shown || shown._id !== c._id || voteRequested[c._id]) return;
      voteRequested[c._id] = true;
      post("vote.json", { id: c._id })
        .then(function (result) {
          // 409 just means chat is already being asked about this one.
          if (result.status === 409 || !result.data.ok) return;
          c.vote = result.data.vote;
          renderVote(c.vote);
          play("speaker");
        })
        .catch(function () { /* the vote is a nicety; a failed start must not break the desk */ });
    }, VOTE_START_DELAY_MS);
  }

  // --- tabs ----------------------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll("[data-ub-tab]"), function (tab) {
    tab.addEventListener("mousedown", function (event) {
      event.stopPropagation(); // otherwise the paper underneath starts dragging
      var wanted = tab.dataset.ubTab;
      Array.prototype.forEach.call(document.querySelectorAll("[data-ub-tab]"), function (other) {
        other.classList.toggle("ub-active", other === tab);
      });
      $("ub-chat-logs").style.display = wanted === "log" ? "block" : "none";
      $("ub-mod-comments").style.display = wanted === "comments" ? "block" : "none";
      $("ub-actions").style.display = wanted === "actions" ? "block" : "none";
      $("ub-hide-bots-toggle").style.display = wanted === "actions" ? "flex" : "none";
      $("ub-log-msg-count").style.display = wanted === "log" ? "block" : "none";
      if (wanted === "log") $("ub-chat-logs").scrollTop = $("ub-chat-logs").scrollHeight;
      if (wanted === "actions") $("ub-actions").scrollTop = $("ub-actions").scrollHeight;
    });
  });

  $("ub-hide-bots").addEventListener("change", function () {
    if (lastDossier) {
      renderActions(lastDossier);
      $("ub-actions").scrollTop = $("ub-actions").scrollHeight;
    }
    // Remembered with the rest of the panel - see savePrefs(). `prefs` is declared below, in the
    // settings section, which is fine: this only runs on a user gesture, long after that.
    prefs.hideBots = $("ub-hide-bots").checked;
    savePrefs();
  });

  // --- settings ------------------------------------------------------------

  // Everything in this panel is a per-VIEWER preference, not channel config: a moderator's font size
  // and mixer levels are nobody else's business and have no place in Mongo (the channel-level knobs
  // live on /<channel>/settings/unban-bureau instead). One localStorage key, written on every change
  // and read once at boot, so the desk comes back the way they left it instead of resetting to
  // 14px/50% every single shift.
  var PREFS_KEY = "ubDeskPrefs";

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch (_) {
      // Storage blocked (private mode, or the user denied it) - the panel still works, it just
      // forgets between visits. Never worth failing the page over.
      return {};
    }
  }

  var prefs = loadPrefs();

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {
      /* ignore - the change still applies for the rest of this shift */
    }
  }

  var fontTargets = {
    chat: { el: "ub-chat-logs", size: 14, min: 8, max: 24, display: "ub-font-chat-display" },
    appeal: { el: "ub-appeal-text", size: 30, min: 10, max: 60, display: "ub-font-appeal-display" },
    visa: { el: "ub-visa-reason", size: 13, min: 8, max: 24, display: "ub-font-visa-display" },
    experts: { el: "ub-experts-body", size: 13, min: 8, max: 24, display: "ub-font-experts-display" },
    rules: { el: "ub-rules-body", size: 13, min: 8, max: 24, display: "ub-font-rules-display" },
  };

  // Applies one font size to its element, the panel's readout and the stored preference.
  function setFontSize(key, size) {
    var target = fontTargets[key];
    target.size = Math.min(target.max, Math.max(target.min, size));
    $(target.el).style.fontSize = target.size + "px";
    $(target.display).textContent = target.size + "px";
  }

  Array.prototype.forEach.call(document.querySelectorAll(".ub-font-btn"), function (btn) {
    btn.addEventListener("click", function () {
      var target = fontTargets[btn.dataset.font];
      var next = target.size + Number(btn.dataset.delta);
      if (next < target.min || next > target.max) return;
      setFontSize(btn.dataset.font, next);
      prefs.fonts = prefs.fonts || {};
      prefs.fonts[btn.dataset.font] = target.size;
      savePrefs();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-vol]"), function (slider) {
    // Applied live while dragging, but only WRITTEN on release - a drag fires `input` dozens of
    // times and each one would be a JSON serialization plus a synchronous storage write.
    slider.addEventListener("input", function () { vol[slider.dataset.vol] = Number(slider.value); });
    slider.addEventListener("change", function () {
      prefs.vol = prefs.vol || {};
      prefs.vol[slider.dataset.vol] = Number(slider.value);
      savePrefs();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name="ub-pick-mode"]'), function (radio) {
    radio.addEventListener("change", function () {
      if (!radio.checked) return;
      pickMode = radio.value;
      prefs.pickMode = pickMode;
      savePrefs();
      applyPickMode();
    });
  });

  // Reorders the remaining queue in place. `shuffle` is the original's default — a channel with a
  // backlog gets variety instead of grinding through it in timestamp order.
  function sortCases() {
    if (pickMode === "shuffle") {
      for (var i = cases.length - 1; i > 0; i -= 1) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = cases[i]; cases[i] = cases[j]; cases[j] = tmp;
      }
      return;
    }
    cases.sort(function (a, b) {
      var delta = new Date(a.requestedAt) - new Date(b.requestedAt);
      return pickMode === "newest" ? -delta : delta;
    });
  }

  function applyPickMode() {
    sortCases();
    current = 0;
    renderCase();
  }

  // Puts the saved preferences back on the controls, before boot's first renderCase(). Ordering
  // matters for the queue: this only SORTS, leaving the render to boot - calling applyPickMode() here
  // would render a case and fetch its dossier before the rest of the page had been wired up.
  //
  // It also fixes a mismatch that predates the saving: the panel's markup ships with `shuffle`
  // checked while `pickMode` starts from the server's own newest/oldest ordering, so the radio said
  // one thing and the queue was in another order until the moderator touched it.
  function restorePrefs() {
    Object.keys(fontTargets).forEach(function (key) {
      var saved = prefs.fonts && Number(prefs.fonts[key]);
      setFontSize(key, Number.isFinite(saved) && saved > 0 ? saved : fontTargets[key].size);
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-vol]"), function (slider) {
      var saved = prefs.vol && Number(prefs.vol[slider.dataset.vol]);
      if (!Number.isFinite(saved)) return;
      var value = Math.min(1, Math.max(0, saved));
      vol[slider.dataset.vol] = value;
      slider.value = String(value);
    });

    if (prefs.hideBots != null) $("ub-hide-bots").checked = Boolean(prefs.hideBots);

    // An unrecognised stored value (an older build, a hand-edited key) falls through to whatever the
    // server ordered the queue by, rather than sorting by a mode nothing implements.
    if (prefs.pickMode === "shuffle" || prefs.pickMode === "oldest" || prefs.pickMode === "newest") {
      pickMode = prefs.pickMode;
    }
    var radio = document.querySelector('input[name="ub-pick-mode"][value="' + pickMode + '"]');
    if (radio) radio.checked = true;
    sortCases();
  }

  $("ub-settings-btn").addEventListener("click", function () { $("ub-settings-modal").classList.add("ub-open"); });
  $("ub-close-settings").addEventListener("click", function () { $("ub-settings-modal").classList.remove("ub-open"); });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (sniperArmed) { setSniper(false); return; }
    $("ub-settings-modal").classList.remove("ub-open");
  });

  // --- live polling --------------------------------------------------------

  function pollLive() {
    var ids = cases.map(function (c) { return c._id; }).slice(0, 50).join(",");
    if (!ids) return;
    fetch("/" + CHANNEL + "/unban-bureau/live.json?ids=" + encodeURIComponent(ids), { headers: { Accept: "application/json" } })
      .then(function (res) { return res.json(); })
      .then(function (payload) {
        if (!payload.ok) return;
        payload.states.forEach(function (state) {
          var c = cases.find(function (item) { return item._id === state.id; });
          if (!c) return;
          c.vote = state.vote;
          c.resolution = state.resolution;
          c.sniper = state.sniper;

          var shown = currentCase();
          if (!shown || shown._id !== state.id) return;
          renderVote(state.vote);
          renderSniper(c);
          if (state.resolution && state.resolution.status === "failed") {
            toast(state.resolution.failureReason || T.decisionFailed);
          }
        });
      })
      .catch(function () { /* a dropped poll is harmless — the next one covers it */ });
  }

  // --- clock ---------------------------------------------------------------

  function tickClock() {
    var now = new Date();
    $("ub-date").textContent =
      String(now.getDate()).padStart(2, "0") + "." +
      String(now.getMonth() + 1).padStart(2, "0") + "." +
      String(now.getFullYear()).slice(-2);
  }

  // Keeps the visa's effective-date picker from offering today/the past - the server rejects those
  // too (lib/unbanDecisionValidation.js), this just steers the picker itself away from them.
  (function setEffectiveDateMin() {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    $("ub-visa-effective-date").min =
      tomorrow.getFullYear() + "-" +
      String(tomorrow.getMonth() + 1).padStart(2, "0") + "-" +
      String(tomorrow.getDate()).padStart(2, "0");
  })();

  // An empty date input shows the browser's OWN locale placeholder ("tt.mm.jjjj", "dd/mm/yyyy",
  // ...), which no attribute can swap for "Немедленно" - so instead the input's own text is made
  // transparent (.ub-date-empty, unban-bureau.css) and #ub-visa-effective-placeholder reads
  // "Немедленно" on top of it. This just keeps that class in sync with whether it's actually empty.
  function updateEffectiveDatePlaceholder() {
    $("ub-visa-effective-date").classList.toggle("ub-date-empty", !$("ub-visa-effective-date").value);
  }
  $("ub-visa-effective-date").addEventListener("input", updateEffectiveDatePlaceholder);

  // --- boot ----------------------------------------------------------------

  document.body.classList.add("ub-playing");
  resize();
  tickClock();
  setInterval(tickClock, 30000);
  // Warms the browser's image cache for the scope cursor before it's ever needed, so arming the
  // sniper for the first time doesn't wait on a fetch mid-gesture.
  new Image().src = IMG + "scope.png";

  // Seeded head-first so the opening queue is already strung out along the path — spawning them all
  // at distance 0 would drop fourteen overlapping bodies on the entrance.
  for (var seed = 13; seed >= 0; seed -= 1) spawnWalker(seed * 55);
  var spawnTimer = setInterval(spawnWalker, 600);
  requestAnimationFrame(stepStreet);

  // Must come before the first renderCase(): it decides the queue order and the font sizes the very
  // first case is drawn with.
  restorePrefs();
  renderCase();
  var liveTimer = setInterval(pollLive, LIVE_POLL_MS);
  var heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  window.addEventListener("pagehide", function () {
    clearInterval(liveTimer);
    clearInterval(spawnTimer);
    clearInterval(heartbeatTimer);
    document.body.classList.remove("ub-playing");

    // Hand the desk back. sendBeacon rather than fetch because the page is already going away - a
    // normal request is cancelled on unload. It can't set headers, so the CSRF token rides in the
    // body (URLSearchParams sends the form content type the server's parser expects).
    if (!shiftEnded && navigator.sendBeacon) {
      navigator.sendBeacon(
        "/" + CHANNEL + "/unban-bureau/release.json",
        new URLSearchParams({ _csrf: CSRF })
      );
    }
  });
})();
