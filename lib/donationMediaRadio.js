// Donation media radio: the pure half. The channel's background music can go past its own playlist
// through a feed of "up next" tracks, filled by three panel actions (lib/radioSources.js asks the
// network; this file only decides what is new and in what order, so it is testable):
//   "radio from this track"  YouTube's own Mix for the track (source `mix`), refilled from the last
//                            played radio track while the radio is on; Last.fm's similar tracks
//                            (`lastfm`) stand in when the Mix gives nothing new.
//   "more of this artist"    the uploading channel's latest videos from its RSS feed (`author`) plus
//                            the artist's top tracks on Last.fm (`lastfm`).
//   "AI, play ..."           a moderator's wish in words; a model names songs (`ai`), each found on
//                            YouTube by search - a song the model made up finds nothing and drops out.
// Any source may fail or return nothing; the feed is filled from whatever answered.

const SOURCES = ["mix", "lastfm", "author", "ai"];
// How many picks each source gets per turn of the round-robin: mix leads, the author's uploads are
// a pinch.
const SOURCE_WEIGHTS = { mix: 3, lastfm: 2, ai: 1, author: 1 };
// A track this short is a Short or a jingle, this long a compilation or a stream recording - neither
// is background music. Unknown duration (the RSS feed has none) passes.
const MIN_SECONDS = 60;
const MAX_SECONDS = 12 * 60;

// Words that mark the same recording uploaded again, not a different song.
const NOISE = /\b(official|music|lyric|lyrics|video|audio|visualizer|visualiser|hd|hq|4k|remaster(ed)?|mv|m\/v|clip|клип|премьера|live|version|ver|full|ft|feat|prod)\b/g;

// "Artist - Title (Official Video) [4K]" -> "artist title": brackets, "official video"-like noise
// and punctuation gone. Two uploads of one song share this key, so the feed does not get both.
function titleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[([{【「].*?[)\]}】」]/g, " ")
    .replace(NOISE, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// "1:02:03" / "4:12" -> seconds; anything else -> 0 (unknown).
function parseDuration(text) {
  if (typeof text === "number") return text > 0 ? Math.round(text) : 0;
  const parts = String(text || "").trim().split(":").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

// Splits a YouTube title into artist and track for Last.fm. `author` (the uploading channel) is the
// fallback artist: an auto-generated "Artist - Topic" channel and most official ones are the artist.
// Returns null when there is nothing usable.
function splitArtistTrack(title, author = "") {
  const clean = String(title || "")
    .replace(/[([{【「].*?[)\]}】」]/g, " ")
    .replace(/\b(official|music|lyric|lyrics|video|audio|visualizer|hd|hq|4k|mv)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const dash = clean.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (dash) return { artist: dash[1].trim(), track: dash[2].replace(/\s+(ft|feat)\.?\s.*$/i, "").trim() };
  const artist = String(author || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*(official)?\s*$/i, "")
    .trim();
  if (!artist || !clean) return null;
  return { artist, track: clean };
}

// Mixes what the sources returned into one list of new candidates.
//   results   { mix: [...], lastfm: [...], author: [...], ai: [...] }, each item
//             { videoId, title, author, duration } (duration in seconds, 0 = unknown)
//   exclude   Set of videoIds never to offer (played recently, blocked, already in the feed or the
//             playlist)
//   excludeKeys  Set of titleKey()s, the same for re-uploads of one song
//   limit     how many to return
// Round-robin by SOURCE_WEIGHTS, so a source that returned fifty does not crowd out the rest.
function mergeCandidates(results, { exclude = new Set(), excludeKeys = new Set(), limit = 20 } = {}) {
  const seenIds = new Set(exclude);
  const seenKeys = new Set(excludeKeys);
  const lists = SOURCES.map((source) => ({ source, items: (results && Array.isArray(results[source]) ? results[source] : []).slice(), weight: SOURCE_WEIGHTS[source] }));
  const out = [];
  const take = (source, item) => {
    if (!item || !/^[\w-]{11}$/.test(item.videoId || "")) return;
    if (seenIds.has(item.videoId)) return;
    const duration = parseDuration(item.duration);
    if (duration && (duration < MIN_SECONDS || duration > MAX_SECONDS)) return;
    const key = titleKey(item.title);
    if (key && seenKeys.has(key)) return;
    seenIds.add(item.videoId);
    if (key) seenKeys.add(key);
    out.push({
      videoId: item.videoId,
      title: String(item.title || "").slice(0, 200),
      author: String(item.author || "").slice(0, 100),
      duration,
      source,
    });
  };
  while (out.length < limit && lists.some((l) => l.items.length > 0)) {
    for (const list of lists) {
      for (let i = 0; i < list.weight && list.items.length > 0 && out.length < limit; i++) {
        const before = out.length;
        // Skip past rejected items within this source's turn, so a run of duplicates does not
        // cost the source its whole share.
        while (list.items.length > 0 && out.length === before) take(list.source, list.items.shift());
      }
    }
  }
  return out;
}

module.exports = { SOURCES, SOURCE_WEIGHTS, MIN_SECONDS, MAX_SECONDS, titleKey, parseDuration, splitArtistTrack, mergeCandidates };
