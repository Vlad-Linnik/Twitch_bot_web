// A viewer's Twitch chat colour, made safe to print on the site's dark background.
//
// The colour comes from Helix (TwitchProfileCache.chatColor) and goes into a style attribute, so it
// is accepted only as #RRGGBB - anything else is no colour at all. Twitch lets anyone pick a colour
// that is unreadable on near-black (#0000FF, #000000), and chat itself lightens such names in dark
// mode; this does the same: a colour darker than MIN_LUMINANCE is mixed with white until it is not.
const MIN_LUMINANCE = 0.18;

function channel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

// "#RRGGBB" readable on a dark background, or null when `hex` is not a colour.
function readableChatColor(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  let rgb = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  for (let step = 0; step < 20 && luminance(rgb) < MIN_LUMINANCE; step++) {
    rgb = rgb.map((c) => c + (255 - c) * 0.15);
  }
  return toHex(rgb);
}

module.exports = { readableChatColor, luminance, MIN_LUMINANCE };
