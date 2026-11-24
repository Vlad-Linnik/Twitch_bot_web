// Web-only (the bot never reads these - see ../CLAUDE.md's shared-collections table): what the
// donation media radio remembers (lib/musicGraph.js holds the rules, lib/musicRadio.js calls this).
//
// MusicGraphTracks - global, one row per YouTube video, the similarity half of the graph. Every row
// is a request to YouTube or Last.fm that need not be made again:
//   { _id: videoId, title, author, duration,
//     song, artist                     lib/musicGraph.js songId() / artistOf(): how a row is found when
//                                      another upload of the song, or another of its artist's, is asked for
//     out: [videoId],                  the Mix of this video in its order; absent until it is asked for
//     similar: [{ artist, track, match }],   Last.fm's answer, likewise
//     expandedAt,                      when the two were asked for; older than EXPAND_TTL_MS = again
//     links: [{ v: videoId, s }],      neighbours found another way (Last.fm searched, the artist's)
//     energy,                          how lively the song is, -1..1, null when the model asked did not
//                                      know; absent until it was asked (lib/musicEnergy.js)
//     embed, embedAt,                  does it play in an embedded player, and when that was learnt
//     usedAt }                         TTL index: a track no radio has come near for 180 days goes
//
// MusicGraphTaste - per channel, the taste half: one row per song (`from: null`) and per edge:
//   { channelId, from, id, score, at (ms), updatedAt (TTL 180 days),
//     and for a song: plays, listens, skips, lastPlayedAt, listenedAt (ms), videoId, title, author }
// `id` and `from` are songId()s, not video ids: another upload is the same song.
//
// MusicGraphStats - per channel, day (YYYY-MM-DD, UTC) and source, counters. For a track's source,
// by outcome (lib/musicGraph.js OUTCOMES, plus `error`): is the graph skipped less than the sources
// it replaced. For the source "supply": how many batches the graph answered by itself (`graph`),
// how often each outside source was asked (`mix`, `lastfm`, `artist`, `oembed`), and how many Mixes
// were opened only to grow (`grow`).
const { connectWeb } = require("./connection");
const { songId, artistOf } = require("../lib/musicGraph");

const DAY_MS = 24 * 60 * 60 * 1000;
// What goes well with a song hardly changes; what a fresh answer would add is this month's releases.
const EXPAND_TTL_MS = 120 * DAY_MS;
const USED_TTL_S = (180 * DAY_MS) / 1000;
const TOUCH_AFTER_MS = 7 * DAY_MS;
// Enough for years of one channel's radio, and a bound on what a restart loads.
const TASTE_LIMIT = 20000;
// loadAround: how many opened neighbours are followed one step further, and how many rows list the
// seed as theirs.
const AROUND_OPENED = 40;
const AROUND_PARENTS = 30;
const LINKS_MAX = 60;

let cols;

async function ensureInitialized() {
  if (cols) return cols;
  const db = await connectWeb();
  const tracks = db.collection("MusicGraphTracks");
  const taste = db.collection("MusicGraphTaste");
  const stats = db.collection("MusicGraphStats");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await Promise.all([
      tracks.createIndex({ usedAt: 1 }, { expireAfterSeconds: USED_TTL_S }),
      tracks.createIndex({ song: 1 }),
      tracks.createIndex({ artist: 1 }),
      tracks.createIndex({ out: 1 }),
      taste.createIndex({ channelId: 1, from: 1, id: 1 }, { unique: true }),
      taste.createIndex({ updatedAt: 1 }, { expireAfterSeconds: USED_TTL_S }),
      stats.createIndex({ channelId: 1, day: 1, source: 1 }, { unique: true }),
    ]);
  } catch (err) {
    console.error("[musicGraphRepo] createIndex failed:", err.message);
  }
  cols = { tracks, taste, stats };
  return cols;
}

// A stored row as lib/musicRadio.js takes it. A stale Mix is left out - the node then reads as
// unopened - but what was found other ways stays.
function toTrack(doc) {
  const fresh = doc.expandedAt && Date.now() - doc.expandedAt.getTime() < EXPAND_TTL_MS;
  return {
    videoId: doc._id,
    title: doc.title || "",
    author: doc.author || "",
    duration: doc.duration || 0,
    out: fresh && Array.isArray(doc.out) && doc.out.length > 0 ? doc.out : null,
    similar: Array.isArray(doc.similar) ? doc.similar : [],
    links: Array.isArray(doc.links) ? doc.links.filter((l) => l && l.v) : [],
    embed: typeof doc.embed === "boolean" ? doc.embed : null,
    embedAt: doc.embedAt ? doc.embedAt.getTime() : 0,
    energy: doc.energy,
  };
}

// Everything known around some tracks, as a flat list of rows: the tracks themselves (or another
// upload of the same song), their neighbours, the rows that list them, and the neighbours of all
// those that have been opened.
async function loadAround(seeds) {
  const { tracks } = await ensureInitialized();
  const found = await tracks
    .find({ $or: [{ _id: { $in: seeds.map((s) => s.videoId) } }, { song: { $in: seeds.map((s) => songId(s)) } }] })
    .limit(50)
    .toArray();
  const rows = new Map(found.map((d) => [d._id, d]));
  const seedIds = [...new Set([...seeds.map((s) => s.videoId), ...rows.keys()])];
  for (const d of await tracks.find({ out: { $in: seedIds } }).sort({ usedAt: -1 }).limit(AROUND_PARENTS).toArray()) rows.set(d._id, d);

  const neighboursOf = (docs) => {
    const ids = new Set();
    for (const d of docs) for (const id of [...(d.out || []), ...(d.links || []).map((l) => l.v)]) if (!rows.has(id)) ids.add(id);
    return [...ids];
  };
  const first = await tracks.find({ _id: { $in: neighboursOf(rows.values()) } }).toArray();
  for (const d of first) rows.set(d._id, d);
  const opened = first.filter((d) => Array.isArray(d.out) && d.out.length > 0).slice(0, AROUND_OPENED);
  for (const d of await tracks.find({ _id: { $in: neighboursOf(opened) } }).toArray()) rows.set(d._id, d);

  const ids = [...rows.keys()];
  if (ids.length > 0) {
    tracks
      .updateMany({ _id: { $in: ids }, usedAt: { $lt: new Date(Date.now() - TOUCH_AFTER_MS) } }, { $set: { usedAt: new Date() } })
      .catch((err) => console.error("[musicGraphRepo] touch failed:", err.message));
  }
  return [...rows.values()].map(toTrack);
}

// The whole graph, the rows used last first. Looking at it does not count as use.
async function loadAll(limit) {
  const { tracks } = await ensureInitialized();
  return (await tracks.find({}).sort({ usedAt: -1 }).limit(limit).toArray()).map(toTrack);
}

async function findByArtist(artist, limit = 60) {
  const { tracks } = await ensureInitialized();
  return (await tracks.find({ artist }).sort({ usedAt: -1 }).limit(limit).toArray()).map(toTrack);
}

async function findTrack(videoId) {
  const { tracks } = await ensureInitialized();
  const doc = await tracks.findOne({ _id: videoId });
  return doc ? toTrack(doc) : null;
}

// Only what is known: the row is shared, and a track met without its artist or length must not take
// them off a row that has them.
function info(t) {
  const out = { usedAt: new Date() };
  if (t.title) out.title = t.title;
  if (t.author) out.author = t.author;
  if (t.duration > 0) out.duration = t.duration;
  const song = songId(t);
  if (!song.startsWith("v:")) {
    out.song = song;
    out.artist = artistOf(t.title, t.author);
  }
  return out;
}

function upserts(list) {
  return list.map((t) => ({ updateOne: { filter: { _id: t.videoId }, update: { $set: info(t) }, upsert: true } }));
}

// track: the node's { videoId, title, author, duration }; list: its Mix; similar: Last.fm's.
async function saveNeighbours(track, list, similar) {
  const { tracks } = await ensureInitialized();
  await tracks.bulkWrite(
    [
      {
        updateOne: {
          filter: { _id: track.videoId },
          update: { $set: { ...info(track), out: list.map((t) => t.videoId), similar, expandedAt: new Date() } },
          upsert: true,
        },
      },
      ...upserts(list),
    ],
    { ordered: false }
  );
}

// links: [{ track, s }], added to the row's own: another channel may have found others, and the graph
// in memory need not have loaded them. The stronger of two stands. Writes go one after another, or two
// at once would each add to what it read before the other.
let linkWrites = Promise.resolve();
function saveLinks(track, links) {
  const write = linkWrites.then(() => addLinks(track, links));
  linkWrites = write.catch(() => {});
  return write;
}

async function addLinks(track, links) {
  const { tracks } = await ensureInitialized();
  const doc = await tracks.findOne({ _id: track.videoId }, { projection: { links: 1 } });
  const merged = mergeLinks(doc && doc.links, links.map((l) => ({ v: l.track.videoId, s: l.s })));
  const stay = new Set(merged.map((l) => l.v));
  await tracks.bulkWrite(
    [
      {
        updateOne: {
          filter: { _id: track.videoId },
          update: { $set: { ...info(track), links: merged } },
          upsert: true,
        },
      },
      ...upserts(links.map((l) => l.track).filter((t) => stay.has(t.videoId))),
    ],
    { ordered: false }
  );
}

function mergeLinks(stored, added) {
  const best = new Map();
  for (const l of [...(Array.isArray(stored) ? stored : []), ...added]) if (l && l.v && l.s > (best.get(l.v) || 0)) best.set(l.v, l.s);
  return [...best].map(([v, s]) => ({ v, s })).sort((a, b) => b.s - a.s).slice(0, LINKS_MAX);
}

async function saveEmbed(videoId, embed) {
  const { tracks } = await ensureInitialized();
  await tracks.updateOne({ _id: videoId }, { $set: { embed, embedAt: new Date() } });
}

async function saveEnergy(rows) {
  const { tracks } = await ensureInitialized();
  await tracks.bulkWrite(
    rows.map((r) => ({ updateOne: { filter: { _id: r.videoId }, update: { $set: { energy: r.energy } } } })),
    { ordered: false }
  );
}

async function loadTaste(channelId) {
  const { taste } = await ensureInitialized();
  return taste
    .find({ channelId: String(channelId) }, { projection: { _id: 0, channelId: 0, updatedAt: 0 } })
    .sort({ at: -1 })
    .limit(TASTE_LIMIT)
    .toArray();
}

// rows: MusicGraph.record()'s.
async function saveTaste(channelId, rows) {
  if (rows.length === 0) return;
  const { taste } = await ensureInitialized();
  const updatedAt = new Date();
  await taste.bulkWrite(
    rows.map(({ from, id, ...rec }) => ({
      updateOne: { filter: { channelId: String(channelId), from: from || null, id }, update: { $set: { ...rec, updatedAt } }, upsert: true },
    })),
    { ordered: false }
  );
}

async function count(channelId, source, what, n = 1) {
  const { stats } = await ensureInitialized();
  const day = new Date().toISOString().slice(0, 10);
  await stats.updateOne({ channelId: String(channelId), day, source }, { $inc: { [what]: n } }, { upsert: true });
}

// --- the admin's view (routes/adminMusicGraph.js) --------------------------------------------------

async function channelsWithTaste() {
  const { taste } = await ensureInitialized();
  return taste.distinct("channelId");
}

// One track by its video id or by words of its title, the most used first.
async function search(text) {
  const { tracks } = await ensureInitialized();
  if (/^[\w-]{11}$/.test(text)) {
    const exact = await tracks.findOne({ _id: text });
    if (exact) return [toTrack(exact)];
  }
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (words.length === 0) return [];
  const all = words.slice(0, 8).map((w) => ({ song: { $regex: w } }));
  // A song whose Mix is known has something around it to show.
  const opened = await tracks.find({ $and: [...all, { out: { $exists: true } }] }).sort({ usedAt: -1 }).limit(1).toArray();
  return (opened.length > 0 ? opened : await tracks.find({ $and: all }).sort({ usedAt: -1 }).limit(1).toArray()).map(toTrack);
}

// { supply: { graph, mix, ... }, sources: { "<source>": { listened, skipEarly, ... } } }
async function statsSince(channelId, days) {
  const { stats } = await ensureInitialized();
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const out = { supply: {}, sources: {} };
  for (const { _id, channelId: c, day, source, ...counts } of await stats.find({ channelId: String(channelId), day: { $gte: since } }).toArray()) {
    const into = source === "supply" ? out.supply : (out.sources[source] = out.sources[source] || {});
    for (const [what, n] of Object.entries(counts)) into[what] = (into[what] || 0) + n;
  }
  return out;
}

module.exports = {
  loadAround,
  loadAll,
  findTrack,
  findByArtist,
  saveNeighbours,
  saveLinks,
  saveEmbed,
  saveEnergy,
  loadTaste,
  saveTaste,
  count,
  channelsWithTaste,
  search,
  statsSince,
  EXPAND_TTL_MS,
  // for tests
  _mergeLinks: mergeLinks,
  _info: info,
};
