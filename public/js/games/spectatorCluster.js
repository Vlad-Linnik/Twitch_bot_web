// Shared visual spectator cluster (views/partials/spectatorCluster.ejs) for
// multiplayer game rooms - Durak, Sunduchki, Battleship, Pong, Connect Four.
// Renders up to MAX_ICONS "viewer" icons piled together (golden-angle spiral,
// not a grid, so they read as a crowd) and shows/hides the whole widget as
// the live spectator count changes.
//
// Durak/Sunduchki additionally let a spectator pick their own skin from
// SPECTATOR_EMOTES (views/partials/spectatorCluster.ejs's picker buttons,
// wired by public/js/games/spectatorEmotePicker.js) - realtime/spectatorEmotes.js
// server-validates the id, and durakRoomManager.js/sunduchkiRoomManager.js's
// serializeRoomMeta sends the room's current spectators' picks as
// room.spectatorEmotes, one entry per spectator. update() accepts either that
// array (this codepath) or a bare count (Battleship/Pong/Connect Four's
// quickMatchClient.js, which has no per-spectator skin - every icon just
// stays the default viewer image).
//
// Two markup variants share this one module (see spectatorCluster.ejs) - a
// fixed panel in the page's left margin (id="spectator-cluster", visible only
// at the xl breakpoint where that margin actually exists) and an inline
// fallback (id="spectator-cluster-inline", visible only BELOW xl via a plain
// CSS media query, not any embedWatch/server-side guess) for contexts with no
// such margin - the spectator-hub iframe is capped well under xl by its own
// layout, but a spectator opening a `?watch=` link directly in a normal wide
// tab gets the exact same margin a player does, so this can't be decided
// server-side. initSpectatorCluster() builds whichever of the two exist on
// the current page and updates both from one call, so callers never need to
// know which is actually visible.
(function () {
  "use strict";

  const MAX_ICONS = 20;
  const GOLDEN_ANGLE_RAD = (137.50776 * Math.PI) / 180;

  // Exposed so spectatorEmotePicker.js's button images can share this exact
  // id -> src mapping instead of duplicating it - "default" here doubles as
  // both the fallback for an unrecognized id and the plain pre-pick icon.
  const SPECTATOR_EMOTES = {
    default: "/images/games/spectator-viewer.png",
    binoculous: "/images/games/spectator-emotes/binoculous.webp",
    hmm: "/images/games/spectator-emotes/hmm.webp",
    peepoblanket: "/images/games/spectator-emotes/peepoblanket.webp",
    peepoclap: "/images/games/spectator-emotes/peepoclap.webp",
    peepocheer: "/images/games/spectator-emotes/peepocheer.webp",
  };
  window.SPECTATOR_EMOTES = SPECTATOR_EMOTES;

  // Deterministic "clustered, not gridded" placement: a tight phyllotaxis
  // spiral outward from the center, with a small per-icon rotation jitter
  // (derived from the index, not Math.random - stays stable across re-renders)
  // so the pile reads as scattered little bodies rather than a rosette.
  function pileOffset(i) {
    const angle = i * GOLDEN_ANGLE_RAD;
    const radius = 9 * Math.sqrt(i + 1);
    const rot = ((i * 47) % 34) - 17;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, rot };
  }

  // Builds one pile instance (fixed or inline) - returns null if its markup
  // isn't on this page so buildAll() below can skip it cleanly.
  function buildPile(rootId, pileId) {
    const root = document.getElementById(rootId);
    const pile = document.getElementById(pileId);
    if (!root || !pile) return null;

    const icons = [];
    for (let i = 0; i < MAX_ICONS; i++) {
      const img = document.createElement("img");
      img.src = SPECTATOR_EMOTES.default;
      img.dataset.emoteId = "default";
      img.alt = "";
      img.hidden = true;
      const off = pileOffset(i);
      // object-contain is load-bearing: not every emote is a square source
      // image (binoculous.webp is 180x64), and the default object-fit (fill)
      // would stretch/squash a non-square one to fit this fixed w-7 h-7 box.
      img.className = "absolute w-7 h-7 left-1/2 top-1/2 drop-shadow object-contain";
      img.style.transform = "translate(calc(-50% + " + off.x + "px), calc(-50% + " + off.y + "px)) rotate(" + off.rot + "deg)";
      img.style.zIndex = String(i);
      pile.appendChild(img);
      icons.push(img);
    }

    let lastShown = -1;

    // Accepts either a plain spectator count (every icon stays the default
    // viewer image - Battleship/Pong/Connect Four's usage) or an array of
    // per-spectator emote ids (Durak/Sunduchki - room.spectatorEmotes), one
    // pile icon per entry showing that spectator's own chosen skin.
    return function update(countOrEmotes) {
      const emotes = Array.isArray(countOrEmotes) ? countOrEmotes : null;
      const n = Math.max(0, Math.min(MAX_ICONS, emotes ? emotes.length : countOrEmotes || 0));
      if (emotes) {
        for (let i = 0; i < n; i++) {
          const id = SPECTATOR_EMOTES[emotes[i]] ? emotes[i] : "default";
          if (icons[i].dataset.emoteId !== id) {
            icons[i].src = SPECTATOR_EMOTES[id];
            icons[i].dataset.emoteId = id;
          }
        }
      }
      if (n !== lastShown) {
        for (let i = 0; i < MAX_ICONS; i++) icons[i].hidden = i >= n;
        lastShown = n;
      }
      root.style.display = n > 0 ? "" : "none";
    };
  }

  function initSpectatorCluster() {
    const updaters = [buildPile("spectator-cluster", "spectator-cluster-pile"), buildPile("spectator-cluster-inline", "spectator-cluster-inline-pile")].filter(
      Boolean
    );
    if (!updaters.length) return { update: function () {} };

    function update(countOrEmotes) {
      for (const fn of updaters) fn(countOrEmotes);
    }
    update(0);
    return { update: update };
  }

  window.initSpectatorCluster = initSpectatorCluster;
})();
