// Pure emote-name matching/tokenizing helpers behind the comment box's autocomplete + live
// preview (public/js/news-comments.js). No DOM here on purpose - these run against plain
// strings/arrays so they're unit-testable with Node's test runner the same way lib/*.js is
// (see tests/emoteMatch.test.js), even though this file itself ships to the browser as a plain
// <script> (no bundler in this project - see views/newsPost.ejs). The `module.exports` guard at
// the bottom is a no-op in the browser (there is no `module` there) and is what lets the test
// file require() this same file directly.
//
// This is the client-side sibling of lib/commentEmotes.js's buildEmoteLookup/renderCommentBody -
// same whole-token-only matching rule, same lowercase-keyed lookup - but it hands back
// STRUCTURED tokens instead of an HTML string, because the caller builds real DOM nodes
// (Text/<img>) from them rather than ever touching innerHTML with comment text (this codebase's
// standing rule for anything chat/user-derived - see statistics-chat.js's word-cloud comments).

const MIN_AUTOCOMPLETE_CHARS = 3;
const MAX_SUGGESTIONS = 5;

// emoteList: [{name, url}] (routes/news.js inlines this per-channel list, already filtered to
// entries with a resolved image). Keyed lowercase so "jok" matches "Jokerge".
function buildEmoteIndex(emoteList) {
  const index = new Map();
  for (const emote of emoteList || []) {
    if (emote && emote.name && emote.url) index.set(String(emote.name).toLowerCase(), emote);
  }
  return index;
}

// The whitespace-delimited chunk of `text` that contains (or immediately precedes) `caretPos` -
// i.e. "the word the user is currently typing", same boundary rule split(/\s+/) uses elsewhere
// in this codebase for whole-token emote matching.
function getCurrentToken(text, caretPos) {
  const pos = Math.max(0, Math.min(caretPos, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { token: text.slice(start, end), start, end };
}

// Up to `limit` emote names starting with `prefix` (case-insensitive) - shorter names first
// (the "closer" match to a short typed prefix), ties broken alphabetically. Requires at least
// MIN_AUTOCOMPLETE_CHARS - the caller doesn't have to re-check that threshold itself.
function findEmoteMatches(prefix, emoteList, limit) {
  if (!prefix || prefix.length < MIN_AUTOCOMPLETE_CHARS) return [];
  const lower = prefix.toLowerCase();
  return (emoteList || [])
    .filter((e) => e && e.name && e.url && e.name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit || MAX_SUGGESTIONS);
}

// Splits `text` on whitespace (keeping it, so a caller reassembling `value` gets it back
// unchanged) and classifies each chunk as plain text or a recognized emote. `emoteIndex` is a
// buildEmoteIndex() Map, not the raw list, so a caller doing this per keystroke isn't re-scanning
// the whole emote list for every token.
function tokenizeForPreview(text, emoteIndex) {
  return String(text || "")
    .split(/(\s+)/)
    .map((chunk) => {
      if (chunk === "" || /^\s+$/.test(chunk)) return { type: "text", value: chunk };
      const match = emoteIndex.get(chunk.toLowerCase());
      if (match) return { type: "emote", value: chunk, name: match.name, url: match.url };
      return { type: "text", value: chunk };
    });
}

const emoteMatch = {
  MIN_AUTOCOMPLETE_CHARS,
  MAX_SUGGESTIONS,
  buildEmoteIndex,
  getCurrentToken,
  findEmoteMatches,
  tokenizeForPreview,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = emoteMatch;
} else {
  window.EmoteMatch = emoteMatch;
}
