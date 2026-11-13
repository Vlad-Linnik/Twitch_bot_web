// The arithmetic behind the Бюро амнистии's street crowd: chat lines shown as speech bubbles over
// the pedestrians, vote emotes flying from them into the two scoreboards, and the bar under the
// vote that shows the gap between the two sides. No DOM in here - public/js/games/unban-bureau.js
// owns the nodes and the animation frames; this file only decides what to show, where and when,
// so those decisions can be tested without a browser.
//
// WHY THE SCOREBOARD NEEDS A RECONCILER. The authoritative tally is the bot's (UnbanRequests'
// `vote.approve`/`vote.deny`), and the flying emotes come from a different source: the raw chat
// lines the page polls from `messages`. The two arrive out of step. A line is in `messages` the
// moment it is said, while the bot writes the tally at most every 3s and only when a LATER vote
// comes in - so the last votes of a burst can sit unwritten until somebody votes again. A board
// driven by the bot's count alone would let the emote be swallowed and the number move seconds
// later, or not at all.
//
// So the board counts optimistically and lets the bot correct it. Each vote line from a viewer
// the page has not yet seen on that side becomes a local vote: +1 on the board the moment its
// emote lands. Each increase of the bot's count "covers" the oldest uncovered local votes (FIFO).
// The board shows the bot's count, minus covered votes still in the air (so a vote the bot already
// counted still waits for its emote to land), plus landed votes the bot has not counted yet. A
// landed vote nobody covers within LOCAL_VOTE_TTL_MS is dropped - that is what corrects a viewer
// who had voted before the page started listening and merely repeated it, and the most the board
// can ever be wrong by, for how long. Whatever count increase no local vote explains (votes said
// before the page's chat cursor, or lines dropped by the per-poll cap) shows up at once.
//
// Same placement rule as speechMarkup.js beside it: this repo has no bundler, so a file both the
// browser and the tests need lives under public/ and exports itself as a CommonJS module or a
// browser global. Wrapped in an IIFE because the desk's scripts share one global scope.
(function () {
  "use strict";

  // --- vote recognition -----------------------------------------------------

  // Mirrors TwitchBot/games/unbanVote.js's recordVote: whitespace tokens, compared lowercase, and
  // the FIRST token that names either emote decides the side. A line that names neither is not a
  // vote. Kept literally the same so the emote that flies is the side the bot counted.
  function voteSideOf(text, approveEmote, denyEmote) {
    var approve = String(approveEmote || "").toLowerCase();
    var deny = String(denyEmote || "").toLowerCase();
    if (!approve && !deny) return null;
    var tokens = String(text || "").split(/\s+/);
    for (var i = 0; i < tokens.length; i += 1) {
      var lowered = tokens[i].toLowerCase();
      if (!lowered) continue;
      if (lowered === approve) return "approve";
      if (lowered === deny) return "deny";
    }
    return null;
  }

  // --- bubble text ----------------------------------------------------------

  // Code points, not UTF-16 units: slicing a string by .length cuts emoji and other astral
  // characters in half and leaves a lone surrogate on screen.
  function codePoints(text) {
    return Array.from(text);
  }

  // Shortens a chat line to fit a bubble. Cuts on token boundaries, so an emote name is never
  // split into a half-word that no longer matches the emote index; an emote counts as
  // EMOTE_WEIGHT characters because it is drawn as a picture roughly that wide. A single token
  // longer than the whole budget (a URL, a keyboard mash) is cut by code points. The ellipsis is
  // added only when something was actually dropped.
  var EMOTE_WEIGHT = 2;
  var ELLIPSIS = "…";

  function clipBubbleText(text, maxChars, isEmote) {
    var max = Math.max(1, maxChars | 0);
    var tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
    var kept = [];
    var used = 0;
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      var weight = isEmote && isEmote(token) ? EMOTE_WEIGHT : codePoints(token).length;
      var cost = weight + (kept.length ? 1 : 0);
      if (used + cost <= max) {
        kept.push(token);
        used += cost;
        continue;
      }
      if (!kept.length) {
        // The first token alone is over budget: cut inside it, leaving room for the ellipsis.
        return codePoints(token).slice(0, Math.max(1, max - 1)).join("") + ELLIPSIS;
      }
      return kept.join(" ") + ELLIPSIS;
    }
    return kept.join(" ");
  }

  // --- the gap bar ----------------------------------------------------------

  // Fractions of the bar each side fills, plus the lead. Zero votes is an EMPTY bar, not a 50/50
  // one: a split down the middle would read as "chat is divided" when chat has said nothing.
  function voteShares(approve, deny) {
    var a = Math.max(0, Number(approve) || 0);
    var d = Math.max(0, Number(deny) || 0);
    var total = a + d;
    if (!total) return { approve: 0, deny: 0, total: 0, lead: 0 };
    return { approve: a / total, deny: d / total, total: total, lead: a - d };
  }

  // --- the scoreboard reconciler (see the header) ----------------------------

  var LOCAL_VOTE_TTL_MS = 20000;

  // Who the page has seen vote, and on which side - the bot's own dedupe (one voter, one side,
  // switching allowed), replayed client-side so a viewer spamming the emote flies it but counts
  // once. Returns "new", "switch" or "repeat"; only the first two are local votes.
  function recordVoter(voters, userId, side) {
    var key = String(userId || "");
    if (!key) return "repeat";
    var before = voters[key];
    if (before === side) return "repeat";
    voters[key] = side;
    return before ? "switch" : "new";
  }

  function createTally(count) {
    return { base: Math.max(0, Number(count) || 0), votes: [] };
  }

  // A local vote for this side. `landed` true for one that does not fly (reduced motion, or the
  // flight cap was full) - it counts at once.
  function addLocalVote(tally, now, landed) {
    tally.votes.push({ at: now, landed: !!landed, covered: false });
    return tally;
  }

  // The oldest vote still in the air hits the board.
  function landLocalVote(tally, now) {
    for (var i = 0; i < tally.votes.length; i += 1) {
      var v = tally.votes[i];
      if (!v.landed) { v.landed = true; v.at = now; break; }
    }
    return prune(tally, now);
  }

  // The bot's count for this side arrived. An increase covers the oldest uncovered local votes; a
  // decrease (a viewer switched away) is simply the new base.
  function setTallyBase(tally, count, now) {
    var next = Math.max(0, Number(count) || 0);
    var grew = next - tally.base;
    for (var i = 0; i < tally.votes.length && grew > 0; i += 1) {
      if (tally.votes[i].covered) continue;
      tally.votes[i].covered = true;
      grew -= 1;
    }
    tally.base = next;
    return prune(tally, now);
  }

  function prune(tally, now) {
    tally.votes = tally.votes.filter(function (v) {
      if (v.landed && v.covered) return false;
      if (v.landed && now - v.at > LOCAL_VOTE_TTL_MS) return false;
      return true;
    });
    return tally;
  }

  function shownCount(tally) {
    var n = tally.base;
    for (var i = 0; i < tally.votes.length; i += 1) {
      var v = tally.votes[i];
      if (v.covered && !v.landed) n -= 1;
      else if (v.landed && !v.covered) n += 1;
    }
    return Math.max(0, n);
  }

  // --- pacing chat into bubbles --------------------------------------------

  // A poll brings a few seconds of chat at once. Popping all of it in the same frame reads as a
  // glitch, so each line is delayed by its own offset from the oldest line in the batch - the
  // crowd speaks with the rhythm chat actually had, one poll interval behind. Lines that share a
  // timestamp (or a batch squeezed into a shorter window than it spanned) are kept at least
  // `minSpacingMs` apart. Only the newest `maxLines` survive: a raid's wall of text would
  // otherwise queue bubbles for minutes, all of them stale.
  function paceLines(lines, windowMs, minSpacingMs, maxLines) {
    var list = (lines || []).slice(-Math.max(0, maxLines | 0));
    if (!list.length) return [];
    var first = Number(list[0].at) || 0;
    var span = Math.max(1, (Number(list[list.length - 1].at) || 0) - first);
    var squeeze = span > windowMs ? windowMs / span : 1;
    var out = [];
    var last = -Infinity;
    for (var i = 0; i < list.length; i += 1) {
      var offset = Math.max(0, ((Number(list[i].at) || 0) - first) * squeeze);
      var delay = Math.max(offset, last + minSpacingMs);
      out.push({ line: list[i], delay: Math.round(delay) });
      last = delay;
    }
    return out;
  }

  // Picks the pedestrian who "says" a line: one who is on screen, not already talking, and not
  // standing so close to someone who is that the two bubbles would cover each other - the waiting
  // part of the queue is packed a body-width apart, and a bubble is several bodies wide. Random
  // among those, so consecutive lines don't all come out of the head of the queue. `walkers` are
  // {id, x, y, busy}; `spacing` is {x, y}, the clear box around a talking walker; `random` is
  // injectable for the tests. Returns the chosen id, or null when nobody qualifies (the caller drops
  // the line: a missed bubble is better than two on one head or one on top of another).
  function pickSpeaker(walkers, minX, maxX, random, spacing) {
    var rnd = random || Math.random;
    var list = walkers || [];
    var gapX = spacing ? spacing.x : 0;
    var gapY = spacing ? spacing.y : 0;
    var talking = list.filter(function (w) { return w.busy; });
    var free = [];
    for (var i = 0; i < list.length; i += 1) {
      var w = list[i];
      if (w.busy) continue;
      if (w.x < minX || w.x > maxX) continue;
      var crowded = false;
      for (var j = 0; j < talking.length && !crowded; j += 1) {
        crowded = Math.abs(talking[j].x - w.x) < gapX && Math.abs((talking[j].y || 0) - (w.y || 0)) < gapY;
      }
      if (!crowded) free.push(w.id);
    }
    if (!free.length) return null;
    return free[Math.min(free.length - 1, Math.floor(rnd() * free.length))];
  }

  // Where a bubble of `halfWidth` goes for a head at `anchorX`: centred over it, but pushed back
  // inside [margin, boxWidth - margin] - the street clips its overflow, so a walker at the entrance
  // would otherwise get half a bubble. `tail` is the tail's offset from the bubble's left edge, so
  // it still points at the head after the push.
  function bubbleBox(anchorX, halfWidth, boxWidth, margin) {
    var m = margin || 0;
    var centre = Math.max(halfWidth + m, Math.min(boxWidth - halfWidth - m, anchorX));
    var left = centre - halfWidth;
    var tail = Math.max(6, Math.min(2 * halfWidth - 6, anchorX - left));
    return { left: left, tail: tail };
  }

  // --- flight path ----------------------------------------------------------

  // A quadratic curve from the speaker's head to the scoreboard, its control point lifted `arc`
  // above the midpoint so the emote is thrown rather than slid. `t` is eased (fast start, slow
  // arrival) so the board visibly swallows it instead of being hit.
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function flightPoint(from, to, t, arc) {
    var k = easeInOut(Math.max(0, Math.min(1, t)));
    var cx = (from.x + to.x) / 2;
    var cy = Math.min(from.y, to.y) - (arc || 0);
    var u = 1 - k;
    return {
      x: u * u * from.x + 2 * u * k * cx + k * k * to.x,
      y: u * u * from.y + 2 * u * k * cy + k * k * to.y,
    };
  }

  var api = {
    EMOTE_WEIGHT: EMOTE_WEIGHT,
    voteSideOf: voteSideOf,
    clipBubbleText: clipBubbleText,
    voteShares: voteShares,
    LOCAL_VOTE_TTL_MS: LOCAL_VOTE_TTL_MS,
    recordVoter: recordVoter,
    createTally: createTally,
    addLocalVote: addLocalVote,
    landLocalVote: landLocalVote,
    setTallyBase: setTallyBase,
    shownCount: shownCount,
    paceLines: paceLines,
    pickSpeaker: pickSpeaker,
    bubbleBox: bubbleBox,
    flightPoint: flightPoint,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    window.BureauCrowdFx = api;
  }
})();
