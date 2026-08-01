// Renders a news comment's plain-text body to safe HTML, substituting recognized emote names
// with the actual emote image - same substitution the channel emote cloud does
// (twitch/emoteImages.js's getEmoteImageMap), applied to free-text comments instead of counted
// word tokens. There is no allowlisted-tag surface here like lib/newsValidation.js's
// sanitize-html config (comments aren't rich text) - every character of the body is HTML-escaped
// first, and the ONLY unescaped markup ever introduced is the <img> tag this module builds itself
// from a URL that came from our own emote-image map, never from the comment text.
const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// name -> {name, url} keyed lowercase, mirroring wordStatsRepo.js's trackedCanonical technique -
// a comment typed as "arolf" should still resolve against a set that stores "AROLF".
function buildEmoteLookup(emoteMap) {
  const lookup = new Map();
  for (const [name, url] of emoteMap || []) {
    if (url) lookup.set(String(name).toLowerCase(), { name, url });
  }
  return lookup;
}

// Splits on whitespace (capturing it, so it round-trips into the output unchanged - comments
// render with white-space: pre-wrap) and swaps whole-token matches for an <img>. A word-picture
// match followed by punctuation - "AROLF!" - doesn't match, same word-boundary behavior the
// channel word/emote clouds already have (tokens are matched whole, not substring-scanned).
function renderCommentBody(body, lookup) {
  const text = typeof body === "string" ? body : "";
  if (!lookup || lookup.size === 0) return escapeHtml(text);

  return text
    .split(/(\s+)/)
    .map((token) => {
      if (token === "" || /^\s+$/.test(token)) return escapeHtml(token);
      const emote = lookup.get(token.toLowerCase());
      if (!emote) return escapeHtml(token);
      return (
        `<img src="${escapeHtml(emote.url)}" alt="${escapeHtml(emote.name)}" title="${escapeHtml(emote.name)}" ` +
        `class="inline-block h-6 w-auto align-text-bottom mx-0.5" loading="lazy" />`
      );
    })
    .join("");
}

module.exports = { escapeHtml, buildEmoteLookup, renderCommentBody };
