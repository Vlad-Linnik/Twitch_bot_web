// Wires the spectator emote picker buttons (views/partials/spectatorCluster.ejs's
// #spectator-emote-picker / #spectator-emote-picker-inline) that sit under the
// spectator cluster pile (spectatorCluster.js). Only Durak/Sunduchki's clients
// (public/js/games/durak-multiplayer.js, sunduchki-multiplayer.js) call
// initSpectatorEmotePicker - Battleship/Pong/Connect Four never do, so the
// picker just stays hidden there, same opt-in convention as the cluster
// itself being count-only for them.
//
// Same fixed/inline duality as spectatorCluster.js and for the same reason:
// which one is actually visible is decided by a plain CSS breakpoint (the xl
// margin either exists or it doesn't), never by embedWatch or anything else
// server-side - a spectator-hub iframe and a `?watch=` link opened directly
// in a normal wide tab both set embedWatch, but only one of them is actually
// narrow. initSpectatorEmotePicker() wires whichever button rows exist and
// drives both from one show()/hide()/setSelected() call.
(function () {
  "use strict";

  function buildPicker(rootId, onSelect) {
    const root = document.getElementById(rootId);
    if (!root) return null;

    const buttons = Array.prototype.slice.call(root.querySelectorAll("[data-emote-id]"));
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        onSelect(btn.dataset.emoteId);
      });
    });

    return {
      setSelected: function (emoteId) {
        const id = emoteId || "default";
        buttons.forEach(function (btn) {
          btn.classList.toggle("ring-2", btn.dataset.emoteId === id);
          btn.classList.toggle("ring-purple-400", btn.dataset.emoteId === id);
        });
      },
      show: function (emoteId) {
        root.hidden = false;
        this.setSelected(emoteId);
      },
      hide: function () {
        root.hidden = true;
      },
    };
  }

  function initSpectatorEmotePicker(opts) {
    const onSelect = (opts && opts.onSelect) || function () {};
    const pickers = [buildPicker("spectator-emote-picker", onSelect), buildPicker("spectator-emote-picker-inline", onSelect)].filter(Boolean);
    const noop = { show: function () {}, hide: function () {}, setSelected: function () {} };
    if (!pickers.length) return noop;

    return {
      show: function (emoteId) {
        pickers.forEach(function (p) {
          p.show(emoteId);
        });
      },
      hide: function () {
        pickers.forEach(function (p) {
          p.hide();
        });
      },
      setSelected: function (emoteId) {
        pickers.forEach(function (p) {
          p.setSelected(emoteId);
        });
      },
    };
  }

  window.initSpectatorEmotePicker = initSpectatorEmotePicker;
})();
