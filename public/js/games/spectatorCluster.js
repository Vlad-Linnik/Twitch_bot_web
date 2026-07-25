// Shared visual spectator cluster (views/partials/spectatorCluster.ejs) for
// multiplayer game rooms - Durak, Battleship, Pong, Connect Four. Renders up
// to MAX_ICONS "viewer" icons piled together (golden-angle spiral, not a
// grid, so they read as a crowd) and shows/hides the whole widget as the
// live spectator count changes.
(function () {
  "use strict";

  const MAX_ICONS = 20;
  const ICON_SRC = "/images/games/spectator-viewer.png";
  const GOLDEN_ANGLE_RAD = (137.50776 * Math.PI) / 180;

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

  function initSpectatorCluster() {
    const root = document.getElementById("spectator-cluster");
    const pile = document.getElementById("spectator-cluster-pile");
    const noop = { update: function () {} };
    if (!root || !pile) return noop;

    const icons = [];
    for (let i = 0; i < MAX_ICONS; i++) {
      const img = document.createElement("img");
      img.src = ICON_SRC;
      img.alt = "";
      img.hidden = true;
      const off = pileOffset(i);
      img.className = "absolute w-7 h-7 left-1/2 top-1/2 drop-shadow";
      img.style.transform = "translate(calc(-50% + " + off.x + "px), calc(-50% + " + off.y + "px)) rotate(" + off.rot + "deg)";
      img.style.zIndex = String(i);
      pile.appendChild(img);
      icons.push(img);
    }

    let lastShown = -1;

    function update(count) {
      const n = Math.max(0, Math.min(MAX_ICONS, count || 0));
      if (n !== lastShown) {
        for (let i = 0; i < MAX_ICONS; i++) icons[i].hidden = i >= n;
        lastShown = n;
      }
      root.style.display = n > 0 ? "" : "none";
    }

    update(0);
    return { update: update };
  }

  window.initSpectatorCluster = initSpectatorCluster;
})();
