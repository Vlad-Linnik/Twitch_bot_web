// Web-only: MusicGraphArtists, Last.fm's tags of the music graph's artists, one row per artist for every
// channel (lib/musicTagRegistry.js):
//   { _id: lib/musicGraph.js artistOf(), name: as Last.fm was asked, tags: [{ name, count }] as it
//     answered ([]: nothing), at }
// Kept as answered: what is made of the tags (lib/musicTags.js) may change without asking again.
const { connectWeb } = require("./connection");

const KEEP_S = 300 * 24 * 60 * 60;
const TAGS_MAX = 25;

let col;

async function ensureInitialized() {
  if (col) return col;
  const artists = (await connectWeb()).collection("MusicGraphArtists");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await artists.createIndex({ at: 1 }, { expireAfterSeconds: KEEP_S });
  } catch (err) {
    console.error("[musicArtistsRepo] createIndex failed:", err.message);
  }
  col = artists;
  return col;
}

async function load(ids) {
  const artists = await ensureInitialized();
  return artists.find({ _id: { $in: ids } }).toArray();
}

async function save(id, { name, tags, at }) {
  const artists = await ensureInitialized();
  await artists.updateOne({ _id: id }, { $set: { name, tags: tags.slice(0, TAGS_MAX), at } }, { upsert: true });
}

async function count() {
  const artists = await ensureInitialized();
  return artists.estimatedDocumentCount();
}

module.exports = { load, save, count };
