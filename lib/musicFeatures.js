// Changes to how the music graph chooses, each with a switch (the site admin's, /admin/music-graph):
// "off", "half" - a coin per batch of tracks - or "all". With "half" the journal (lib/musicJournal.js)
// shows the same channel's skips with it and without, which is how it is decided whether to keep one.
// "similar" and "start" have no half: what they bring stays in the graph or decides a whole evening.
const MODES = ["off", "half", "all"];
const FEATURES = {
  tags: { modes: MODES, initial: "half" }, // genre (lib/musicTags.js)
  crowd: { modes: MODES, initial: "half" }, // what several other channels skip
  model: { modes: MODES, initial: "half" }, // the learnt weights, once there are any (lib/musicRank.js)
  similar: { modes: ["off", "all"], initial: "all" }, // songs Last.fm named, out of Mongo
  start: { modes: ["off", "all"], initial: "all" }, // endless music starts from the channel's favourites
};

function normalize(stored) {
  const out = {};
  for (const [name, f] of Object.entries(FEATURES)) out[name] = stored && f.modes.includes(stored[name]) ? stored[name] : f.initial;
  return out;
}

class MusicFeatures {
  constructor({ random = Math.random, modes = null } = {}) {
    this.random = random;
    this.modes = normalize(modes);
  }

  set(stored) {
    this.modes = normalize(stored);
  }

  // Is one on regardless of the coin?
  on(name) {
    return this.modes[name] !== "off";
  }

  // { tags: true, ... } for one batch.
  draw() {
    const out = {};
    for (const [name, mode] of Object.entries(this.modes)) {
      if (FEATURES[name].modes.includes("half")) out[name] = mode === "all" || (mode === "half" && this.random() < 0.5);
    }
    return out;
  }
}

module.exports = { MusicFeatures, FEATURES, normalize };
