// The learnt weights in use (lib/musicRank.js), as jobs/musicRankTrain.js last stored them. A channel goes
// by its own model when it has one worth using, else by everyone's.
const { usable, NAMES } = require("./musicRank");

let models = new Map(); // "all" | channelId -> model

function set(list) {
  models = new Map((list || []).map((m) => [String(m._id), m]));
}

// { model, inUse }: the model whose word is worth noting, and whether it may be acted on.
function forChannel(channelId) {
  const list = [models.get(String(channelId)), models.get("all")].filter((m) => m && Array.isArray(m.weights) && m.names && m.names.join() === NAMES.join());
  const ready = list.find(usable);
  return ready || list[0] ? { model: ready || list[0], inUse: Boolean(ready) } : null;
}

const get = (id) => models.get(String(id)) || null;

module.exports = { set, get, forChannel };
