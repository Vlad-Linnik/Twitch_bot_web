// Donation media radio: the network half - where "similar tracks" come from. The mixing rules are in
// lib/donationMediaRadio.js; this file only asks the outside world. Every function here resolves to
// a list (possibly empty) and never throws: a source that is down must not take the feed with it.
//
// Three of these read YouTube's own web pages (the Mix, the search results, the watch page for a
// channel id), because YouTube's Data API has no "related videos" since 2023 and its search costs a
// key and a 100-a-day quota. The pages carry their data as one JSON blob (`ytInitialData`); if
// YouTube changes it, these return [] and the feed runs on Last.fm and the AI alone.
const { splitArtistTrack, mergeCandidates } = require("./donationMediaRadio");

const TIMEOUT_MS = 10000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 1000;
// Pretend to be a browser, and carry the EU consent cookie: without it a European server is shown
// the consent page instead of the video.
const PAGE_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9,ru;q=0.8",
  cookie: "CONSENT=YES+1; SOCS=CAI",
};
const LASTFM_ENDPOINT = "https://ws.audioscrobbler.com/2.0/";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
// The cheapest model the site already uses elsewhere; a list of song names needs no thinking.
const GEMINI_MODEL = "gemini-3.5-flash-lite";

// --- a small TTL cache, shared by every channel -------------------------------------------------
const cache = new Map(); // key -> { at, value: Promise }
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const value = load().catch(() => []);
  cache.set(key, { at: Date.now(), value });
  // A failure is not kept for six hours: the next fill asks again.
  value.then((v) => {
    if (!v || (Array.isArray(v) && v.length === 0)) cache.delete(key);
  });
  return value;
}

async function getText(url, headers = PAGE_HEADERS) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function initialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

// Every value under `key`, at any depth.
function collect(node, key, out = []) {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
  }
  return out;
}

const textOf = (t) => (t ? t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r.text).join("") : "") : "");

// --- YouTube ------------------------------------------------------------------------------------

// The "Mix" YouTube builds for a video: about 25 tracks, the seed first.
function youtubeMix(videoId) {
  return cached(`mix:${videoId}`, async () => {
    const html = await getText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=RD${encodeURIComponent(videoId)}`);
    return collect(initialData(html), "playlistPanelVideoRenderer")
      .map((v) => ({ videoId: v.videoId, title: textOf(v.title), author: textOf(v.shortBylineText), duration: textOf(v.lengthText) }))
      .filter((v) => v.videoId && v.videoId !== videoId);
  });
}

// The first videos YouTube's search finds (videos only - the `sp` filter).
function youtubeSearch(query, max = 3) {
  const q = String(query || "").trim().slice(0, 150);
  if (!q) return Promise.resolve([]);
  return cached(`search:${q.toLowerCase()}`, async () => {
    const html = await getText(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`);
    return collect(initialData(html), "videoRenderer")
      .map((v) => ({ videoId: v.videoId, title: textOf(v.title), author: textOf(v.ownerText), duration: textOf(v.lengthText) }))
      .filter((v) => v.videoId);
  }).then((list) => list.slice(0, max));
}

// The best search hit for "artist - track": the first one that is not a cover, a reaction or a
// lesson, if any of the first three is not.
async function findOnYoutube(artist, track) {
  const hits = await youtubeSearch(`${artist} - ${track}`, 3);
  const bad = /\b(cover|reaction|karaoke|tutorial|lesson|разбор|кавер|реакция|караоке)\b/i;
  return hits.find((h) => !bad.test(h.title)) || null;
}

// The channel a video belongs to, read off its watch page.
function channelIdOf(videoId) {
  return cached(`channel:${videoId}`, async () => {
    const html = await getText(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    const m = html.match(/"channelId":"(UC[\w-]{22})"/);
    return m ? [m[1]] : [];
  }).then((list) => list[0] || null);
}

// The channel's latest uploads from its RSS feed - official and keyless. Shorts are dropped (their
// link says so); the feed carries no durations.
async function authorUploads(videoId) {
  const channelId = await channelIdOf(videoId);
  if (!channelId) return [];
  return cached(`rss:${channelId}`, async () => {
    const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {});
    const author = (xml.match(/<author>\s*<name>([^<]*)<\/name>/) || [])[1] || "";
    const out = [];
    for (const entry of xml.split("<entry>").slice(1)) {
      const id = (entry.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1];
      const link = (entry.match(/<link rel="alternate" href="([^"]*)"/) || [])[1] || "";
      const title = (entry.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      if (!id || id === videoId || link.includes("/shorts/")) continue;
      out.push({ videoId: id, title: decodeXml(title), author: decodeXml(author), duration: 0 });
    }
    return out;
  });
}

function decodeXml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// oEmbed answers 401/403 for a video whose owner turned embedding off - the OBS player could not
// play it anyway. Returns { title, author } or null (not embeddable, gone, or unknown).
function embedInfo(videoId) {
  return cached(`embed:${videoId}`, async () => {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = await res.json();
    return [{ title: String(data.title || ""), author: String(data.author_name || "") }];
  }).then((list) => list[0] || null);
}

// --- Last.fm ------------------------------------------------------------------------------------

async function lastfm(method, params) {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return null;
  const query = new URLSearchParams({ method, ...params, api_key: key, format: "json", autocorrect: "1" });
  const res = await fetch(`${LASTFM_ENDPOINT}?${query}`, {
    headers: { "user-agent": "ChatWizardBot donation-media radio" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && !data.error ? data : null;
}

// Similar tracks to the seed, as { artist, track } pairs. Falls back to similar artists' top tracks
// when Last.fm knows the artist but not this exact track (common for a title with extra words).
function lastfmSimilar(seedTitle, seedAuthor, max = 8) {
  const parts = splitArtistTrack(seedTitle, seedAuthor);
  if (!parts || !process.env.LASTFM_API_KEY) return Promise.resolve([]);
  return cached(`lastfm:${parts.artist}|${parts.track}`.toLowerCase(), async () => {
    const similar = await lastfm("track.getsimilar", { artist: parts.artist, track: parts.track, limit: "40" });
    let pairs = ((similar && similar.similartracks && similar.similartracks.track) || []).map((t) => ({ artist: t.artist && t.artist.name, track: t.name }));
    if (pairs.length === 0) {
      const artists = await lastfm("artist.getsimilar", { artist: parts.artist, limit: "12" });
      const names = ((artists && artists.similarartists && artists.similarartists.artist) || []).map((a) => a.name);
      for (const name of shuffle(names).slice(0, 6)) {
        const top = await lastfm("artist.gettoptracks", { artist: name, limit: "5" });
        const tracks = (top && top.toptracks && top.toptracks.track) || [];
        if (tracks.length) {
          const t = tracks[Math.floor(Math.random() * tracks.length)];
          pairs.push({ artist: name, track: t.name });
        }
      }
    }
    return pairs.filter((p) => p.artist && p.track);
  }).then((pairs) => resolvePairs(shuffle(pairs.slice()).slice(0, max)));
}

// The artist's own most-played tracks, as YouTube videos.
function lastfmArtistTop(seedTitle, seedAuthor, max = 6) {
  const parts = splitArtistTrack(seedTitle, seedAuthor);
  if (!parts || !process.env.LASTFM_API_KEY) return Promise.resolve([]);
  return cached(`lastfmtop:${parts.artist}`.toLowerCase(), async () => {
    const top = await lastfm("artist.gettoptracks", { artist: parts.artist, limit: "30" });
    return ((top && top.toptracks && top.toptracks.track) || [])
      .map((t) => ({ artist: (t.artist && t.artist.name) || parts.artist, track: t.name }))
      .filter((p) => p.track);
  }).then((pairs) => resolvePairs(shuffle(pairs.slice()).slice(0, max)));
}

// --- the AI -------------------------------------------------------------------------------------

const AI_MIN = 5;
const AI_MAX = 10;
const WISH_MAX = 200;

// A moderator's free-text wish ("something cheerful") -> songs a model picked, found on YouTube by
// search, which is what drops the ones it made up. `context`: what plays now and some of the
// channel's own playlist, so "more like this" or "but calmer" has something to lean on.
// Off without a GEMINI_API_KEY. Returns { tracks, error } - error "noKey" | "failed" | null.
async function aiWish(wish, { nowPlaying = "", tasteTitles = [], avoidTitles = [] } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { tracks: [], error: "noKey" };
  const text = String(wish || "").trim().slice(0, WISH_MAX);
  if (!text) return { tracks: [], error: null };
  try {
    const prompt = [
      "You pick background music for a Twitch stream. The streamer's moderator asked, in their own words:",
      `"""${text}"""`,
      nowPlaying ? `Playing right now: "${String(nowPlaying).slice(0, 200)}".` : "",
      tasteTitles.length ? `Some tracks from the channel's own playlist (its taste): ${tasteTitles.slice(0, 15).map((t) => `"${String(t).slice(0, 80)}"`).join(", ")}.` : "",
      avoidTitles.length ? `Already queued or just played, do not repeat: ${avoidTitles.slice(0, 30).map((t) => `"${String(t).slice(0, 80)}"`).join(", ")}.` : "",
      `Suggest between ${AI_MIN} and ${AI_MAX} real, existing songs that fit the request (${AI_MAX - 2} is a good number). Only songs that surely exist on YouTube under that artist and title.`,
      "Answer with JSON only.",
    ].filter(Boolean).join("\n");
    const res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      // The key in a header, never in the URL: a URL ends up in error texts and logs.
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { artist: { type: "STRING" }, track: { type: "STRING" } }, required: ["artist", "track"] },
          },
          // Thinking tokens count against this ceiling; one sized to the list alone can come back
          // empty.
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { tracks: [], error: "failed" };
    const data = await res.json();
    const out = (((data.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || "").join("");
    const pairs = JSON.parse(out);
    if (!Array.isArray(pairs)) return { tracks: [], error: "failed" };
    const valid = pairs.filter((p) => p && typeof p.artist === "string" && typeof p.track === "string" && p.artist && p.track);
    return { tracks: await resolvePairs(valid.slice(0, AI_MAX)), error: null };
  } catch (_) {
    return { tracks: [], error: "failed" };
  }
}

// --- the three things the panel can ask for --------------------------------------------------------
// Each returns [{ videoId, title, author, duration, source }], new tracks only: `exclude` (videoIds)
// and `excludeKeys` (lib/donationMediaRadio.js titleKey()s) are what the feed must not get again -
// what is in it, in the playlist, played lately or blocked. Every candidate is checked against
// oEmbed first, so a track whose owner forbade embedding - the OBS player could not show it - never
// reaches the feed.

// "Radio from this track": YouTube's Mix. Last.fm's similar tracks only when the Mix gave nothing new
// (YouTube changed its page, or the Mix is all played already), so the radio does not fall silent.
async function radioFor(seed, { exclude, excludeKeys, limit = 12 } = {}) {
  if (!seed || !seed.videoId) return [];
  const mix = await youtubeMix(seed.videoId).catch(() => []);
  let merged = mergeCandidates({ mix }, { exclude, excludeKeys, limit: limit * 2 });
  if (merged.length === 0) {
    const lastfmHits = await lastfmSimilar(seed.title, seed.author, limit).catch(() => []);
    merged = mergeCandidates({ lastfm: lastfmHits }, { exclude, excludeKeys, limit: limit * 2 });
  }
  return embeddable(merged, limit);
}

// "More of this artist": the uploading channel's latest videos (RSS) plus the artist's top tracks on
// Last.fm. The RSS alone is often live recordings and announcements; Last.fm alone misses a channel
// that is not an artist.
async function moreFromArtist(seed, { exclude, excludeKeys, limit = 8 } = {}) {
  if (!seed || !seed.videoId) return [];
  const [author, lastfmHits] = await Promise.all([
    authorUploads(seed.videoId).catch(() => []),
    lastfmArtistTop(seed.title, seed.author, limit).catch(() => []),
  ]);
  const merged = mergeCandidates({ author: shuffle(author.slice()), lastfm: lastfmHits }, { exclude, excludeKeys, limit: limit * 2 });
  return embeddable(merged, limit);
}

// "AI, play something ...": returns { tracks, error } (see aiWish).
async function aiPick(wish, { exclude, excludeKeys, nowPlaying, tasteTitles, avoidTitles } = {}) {
  const { tracks, error } = await aiWish(wish, { nowPlaying, tasteTitles, avoidTitles });
  const merged = mergeCandidates({ ai: tracks }, { exclude, excludeKeys, limit: AI_MAX });
  return { tracks: await embeddable(merged, AI_MAX), error };
}

async function embeddable(candidates, limit) {
  const out = [];
  for (let i = 0; i < candidates.length && out.length < limit; i += 5) {
    const checked = await Promise.all(candidates.slice(i, i + 5).map((c) => embedInfo(c.videoId).catch(() => null)));
    checked.forEach((info, j) => {
      if (!info || out.length >= limit) return;
      const c = candidates[i + j];
      out.push({ ...c, title: c.title || info.title, author: c.author || info.author });
    });
  }
  return out;
}

// --- helpers --------------------------------------------------------------------------------------

// { artist, track } pairs -> YouTube videos, one search each, a few at a time.
async function resolvePairs(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 4) {
    const found = await Promise.all(pairs.slice(i, i + 4).map((p) => findOnYoutube(p.artist, p.track).catch(() => null)));
    for (const hit of found) if (hit) out.push(hit);
  }
  return out;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

module.exports = { radioFor, moreFromArtist, aiPick, WISH_MAX, embedInfo, _initialData: initialData };
