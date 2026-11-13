// Where emote pictures may be loaded from - one list read by both the Content-Security-Policy
// (app.js's img-src) and the server-side image map (twitch/emoteImages.js).
//
// Why one list: the image map resolves names against six providers, and the page's CSP decides
// which of those pictures the browser is actually allowed to fetch. The two used to be written
// separately, and when BTTV and FFZ were added to the map their CDNs never reached img-src - the
// server handed out correct URLs, the browser refused every one of them, and those emotes drew
// as a zero-width broken image with only the alt text left ("D:", "HYPERCLAP"). Nothing logged it
// server-side; the refusal exists only in the viewer's console.
//
// So the rule is enforced from both ends: the CSP is built FROM this list, and the image map drops
// any URL whose origin is not on it (the view then falls back to the emote's text, which is what an
// unresolved emote already looks like). A new provider whose CDN is missing here therefore shows
// up as text, not as a broken picture - and tests/emoteImageHosts.test.js fails on the builder.

const TWITCH_EMOTE_CDN = "https://static-cdn.jtvnw.net";
const SEVEN_TV_CDN = "https://cdn.7tv.app";
const BTTV_CDN = "https://cdn.betterttv.net";
// FFZ hands out its own urls per size (see emoteImages.js's ffzImagesFromSets); this is the host
// its API returns today. If it ever moves, those emotes degrade to text until it is added here.
const FFZ_CDN = "https://cdn.frankerfacez.com";

// static-cdn.jtvnw.net also serves Twitch avatars, which is why it was the first entry.
const IMAGE_ORIGINS = Object.freeze([TWITCH_EMOTE_CDN, SEVEN_TV_CDN, BTTV_CDN, FFZ_CDN]);
const ORIGIN_SET = new Set(IMAGE_ORIGINS);

// The full img-src directive value for helmet.
const IMG_SRC_DIRECTIVE = Object.freeze(["'self'", "data:", ...IMAGE_ORIGINS]);

// `default` serves the animated file when the emote has one; the theme only decides which
// background the transparent edges were baked against.
const twitchEmoteUrl = (id) => `${TWITCH_EMOTE_CDN}/emoticons/v2/${id}/default/dark/2.0`;
const sevenTvEmoteUrl = (id) => `${SEVEN_TV_CDN}/emote/${id}/2x.webp`;
const bttvEmoteUrl = (id) => `${BTTV_CDN}/emote/${id}/2x.webp`;

// True when the browser will be allowed to load this URL as an <img> under our CSP. Origin
// comparison, not a prefix match: "https://cdn.7tv.app.evil.example/..." must not pass.
function isAllowedImageUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  try {
    return ORIGIN_SET.has(new URL(url).origin);
  } catch {
    return false;
  }
}

module.exports = {
  IMAGE_ORIGINS,
  IMG_SRC_DIRECTIVE,
  isAllowedImageUrl,
  twitchEmoteUrl,
  sevenTvEmoteUrl,
  bttvEmoteUrl,
};
