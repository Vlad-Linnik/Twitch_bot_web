// Which of a channel's emotes actually occur in a given set of chat lines.
//
// Both games that print raw chat - "Угадай чатера" and the example quotations in "Выше — ниже" -
// need the browser to swap emote names for pictures, and the browser needs the URLs to do it. A
// channel's whole set is large (823 emotes on #mistercop, ~66KB as JSON) while a screenful of chat
// contains a handful, so the payload carries the handful.
//
// The matching rule is whole-token and case-insensitive, the same one used by
// lib/commentEmotes.js (server-rendered comments) and public/js/emoteMatch.js (the comment
// editor's live preview). It has to stay the same in all three: a name resolved here and not
// there would ship a URL nothing uses, and the reverse would print a name the client cannot
// resolve.

// emoteMap: Map(name -> url) from twitch/emoteImages.js's getEmoteImageMap.
// Returns [{name, url}] for the emotes some line actually uses, with the SET's spelling of the
// name rather than the chat's - the client keys its index lowercase, and the name doubles as the
// image's alt text, where "AROLF" is what the emote is called and "arolf" is a typo of it.
function pickUsedEmotes(texts, emoteMap) {
  if (!emoteMap || emoteMap.size === 0) return [];

  const byLower = new Map();
  for (const [name, url] of emoteMap) {
    if (url) byLower.set(String(name).toLowerCase(), { name, url });
  }

  const used = new Map();
  for (const text of texts || []) {
    for (const token of String(text || "").trim().split(/\s+/)) {
      if (!token || used.has(token.toLowerCase())) continue;
      const emote = byLower.get(token.toLowerCase());
      if (emote) used.set(token.toLowerCase(), emote);
    }
  }
  return [...used.values()];
}

module.exports = { pickUsedEmotes };
