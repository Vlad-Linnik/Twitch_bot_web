// Closed catalog of "skins" a spectator can broadcast as their own appearance
// in the shared spectator cluster (views/partials/spectatorCluster.ejs) - the
// left-margin pile of viewer icons on Durak/Sunduchki multiplayer room pages.
// "default" is the plain viewer icon (public/images/games/spectator-viewer.png)
// every spectator starts as; the rest are 7TV emotes, downloaded as local
// assets under public/images/games/spectator-emotes/ (see
// public/js/games/spectatorCluster.js's SPECTATOR_EMOTES for the client-side
// id -> src mapping). Shared between durakRoomManager.js and
// sunduchkiRoomManager.js, same as durakClock.js/durakElo.js above them - a
// closed set server-validates a client-supplied id against before ever
// broadcasting it, same reasoning as durakRoomManager.js's own STICKER_IDS.
"use strict";

const SPECTATOR_EMOTE_IDS = new Set(["default", "binoculous", "hmm", "peepoblanket", "peepoclap", "peepocheer"]);

function isValidSpectatorEmote(id) {
  return typeof id === "string" && SPECTATOR_EMOTE_IDS.has(id);
}

module.exports = { SPECTATOR_EMOTE_IDS, isValidSpectatorEmote };
