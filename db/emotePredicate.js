// "Is this token an emote?" for one channel, as the word cloud answers it: the union of the
// currently tracked set (whiteList), everything ever counted as an emote (WordLifetimeStats) and
// the tombstones (EmoteExclusions). whiteList alone is not enough - a channel can stop tracking
// an emote while chat keeps typing it. Any job that tokenizes `messages` itself must use this
// same union, or it disagrees with the tokenizer that wrote ChatWordStats and counts emotes as
// words.
//
// Case-insensitive, because extractWords() checks both the raw token and its lowercased,
// punctuation-stripped form.
async function emotePredicate(db, channel) {
  const [white, life, excluded] = await Promise.all([
    db.collection("whiteList").distinct("word", { channel }),
    db.collection("WordLifetimeStats").distinct("word", { channel }),
    db.collection("EmoteExclusions").distinct("word", { channel }),
  ]);
  const set = new Set([...white, ...life, ...excluded].map((w) => String(w).toLowerCase()));
  return (token) => set.has(String(token).toLowerCase());
}

module.exports = { emotePredicate };
