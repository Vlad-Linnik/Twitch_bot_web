// Genres for the music graph, out of Last.fm's artist tags: what the tags say once cleaned, how alike two
// songs are by them and how lively one is. Pure; lib/musicTagRegistry.js fetches and keeps them.
//
// Tags of the artist, not of the song: of 16 songs Last.fm knew tags for 6, none of them Russian, while
// of 264 tracks of eleven Mixes the artist had tags for 253. They tell genres apart (a song against its
// own Mix 0.42-0.98, against the other Mixes 0.00-0.15), but a namesake brings somebody else's, so they
// only ever tilt a choice, and a song's own are averaged with its neighbours' (blend).
//
// A vector is a Map tag -> weight of length 1. A tag is its letters and digits only: "hip hop",
// "Hip-Hop" and "hiphop" are one.
const keyOf = (name) => String(name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const COUNT_MIN = 8; // of 100
const TAGS_MAX = 12;
const SAME = { hiphop: "hiphop", rap: "rap", russianrap: "rap", belarussianrap: "rap", ukrainianrap: "rap", russianhiphop: "hiphop", westcoastrap: "rap", russianpunk: "punk", punkrock: "punk", electronica: "electronic", electro: "electronic", poprock: "poprock", retrowave: "synthwave", chillsynth: "chillwave", synthpop: "synthpop", electropop: "synthpop", rnb: "rnb", randb: "rnb", drumnbass: "drumandbass", dnb: "drumandbass", lofi: "lofi", lofihiphop: "lofi", videogamemusic: "gamemusic", game: "gamemusic", videogame: "gamemusic", soundtrack: "soundtrack", ost: "soundtrack", chillout: "chillout", chill: "chillout" };
// Where and when it is from, how it was liked, and noise.
const NOT_GENRE = new Set("russian russia rus soviet ussr ukrainian ukraine belarus belarusian belarussian kazakh kazakhstan polish poland german germany french france italian italy spanish spain swedish sweden finnish finland norwegian norway danish dutch belgian belgium romanian canadian canada american usa us british uk english england irish scottish australian japanese japan korean korea turkish brazilian latin seenlive favorites favourites favorite favourite favouriteartists awesome cool best love loved good great amazing beautiful legend legends legendary genius epic sexy shit bad govno cancer crap overrated underrated femalevocalists femalevocalist malevocalists malevocalist female male group band duo solo singersongwriter vocal all music spotify youtube mylove check under2000listeners".split(" "));
// "Alternative metal" is also somewhat "metal".
const FAMILIES = ["metal", "punk", "rock", "pop", "rap", "hiphop", "house", "techno", "trance", "folk", "jazz", "blues", "soul", "ambient", "dance"];
const FAMILY_WEIGHT = 0.5;

// How lively a genre is, -1..1. Rough on purpose, and an artist's, not a song's.
const ENERGY = {
  metal: 1, numetal: 1, alternativemetal: 0.9, heavymetal: 1, thrashmetal: 1, deathmetal: 1, blackmetal: 0.9, speedmetal: 1, powermetal: 1, metalcore: 1, deathcore: 1, industrialmetal: 1, hardcore: 1, posthardcore: 0.9, hardcorepunk: 1, rapcore: 0.9, rapmetal: 0.9, kircore: 0.8,
  punk: 0.9, poppunk: 0.8, skatepunk: 0.9, horrorpunk: 0.8, dancepunk: 0.7, ska: 0.7, hardrock: 0.8, grunge: 0.6, industrial: 0.8, rock: 0.4, alternativerock: 0.4, alternative: 0.3, russianrock: 0.3, classicrock: 0.4, indierock: 0.3, poprock: 0.3, glamrock: 0.6, hairmetal: 0.9,
  dubstep: 1, drumandbass: 1, techno: 0.8, hardstyle: 1, trance: 0.7, house: 0.6, eurodance: 0.9, dance: 0.7, disco: 0.5, funk: 0.5, electrohouse: 0.8, edm: 0.8, phonk: 0.7, breakbeat: 0.7, bigbeat: 0.8, hyperpop: 0.8, electronic: 0.2, frenchhouse: 0.6,
  trap: 0.4, rap: 0.2, hiphop: 0.2, grime: 0.4, cloudrap: -0.3, pop: 0.2, synthpop: 0.3, newwave: 0.2, synthwave: 0.1, postpunk: 0.1, coldwave: -0.1, darkwave: 0, gothicrock: 0.1, indie: 0, indiepop: 0, artrock: 0, progressiverock: 0.1,
  rnb: -0.3, soul: -0.3, triphop: -0.5, downtempo: -0.7, chillwave: -0.6, vaporwave: -0.5, dreampop: -0.6, shoegaze: -0.3, slowcore: -0.9, postrock: -0.4, folk: -0.5, acoustic: -0.7, bard: -0.6, chanson: -0.3, blues: -0.3, jazz: -0.5, smoothjazz: -0.8, bossanova: -0.8, lounge: -0.8, chillout: -0.9, ambient: -1, darkambient: -0.9, drone: -0.9, newage: -1, lofi: -0.9, piano: -0.9, classical: -0.8, contemporaryclassical: -0.9, impressionism: -0.8, meditation: -1, gamemusic: 0, soundtrack: -0.2, instrumental: -0.2, ballad: -0.6,
};

function unit(map) {
  const length = Math.sqrt([...map.values()].reduce((sum, w) => sum + w * w, 0));
  if (!(length > 0)) return null;
  return new Map([...map].map(([tag, w]) => [tag, w / length]));
}

// raw: [{ name, count }], Last.fm's, count 0..100. Returns a vector, or null when nothing is left.
function vectorOf(raw, artistName = "") {
  const own = keyOf(artistName);
  const out = new Map();
  const add = (tag, w) => out.set(tag, Math.max(out.get(tag) || 0, w));
  for (const { name, count } of [...(raw || [])].slice(0, 40)) {
    if (!(count >= COUNT_MIN) || out.size >= TAGS_MAX * 2) continue;
    const key = keyOf(name);
    const tag = SAME[key] || key;
    if (!tag || tag.length < 2 || tag.length > 30 || tag === own || NOT_GENRE.has(tag) || /^(19|20)?\d0s$|^\d+$/.test(tag)) continue;
    add(tag, count / 100);
    const family = FAMILIES.find((f) => tag !== f && tag.endsWith(f));
    if (family) add(family, (count / 100) * FAMILY_WEIGHT);
  }
  return unit(out);
}

function cosine(a, b) {
  if (!a || !b) return null;
  let sum = 0;
  for (const [tag, w] of a.size < b.size ? a : b) sum += w * ((a.size < b.size ? b : a).get(tag) || 0);
  return Math.max(-1, Math.min(1, sum));
}

// list: [[vector, weight]], weights of either sign. A vector, or null.
function mean(list) {
  const out = new Map();
  for (const [vector, weight] of list) if (vector && weight) for (const [tag, w] of vector) out.set(tag, (out.get(tag) || 0) + w * weight);
  return unit(out);
}

// A song's own tags and its neighbours', half and half; whichever there are when one is missing. A
// namesake's tags agree with nobody around, and the neighbours are the only word on an unknown artist.
// With fewer than three tagged neighbours they say little.
const NEIGHBOURS_FEW = 3;
function blend(own, neighbours) {
  const tagged = neighbours.filter(([vector]) => vector);
  const around = tagged.length > 0 ? mean(tagged) : null;
  if (!around) return own || null;
  if (!own) return around;
  const weight = tagged.length < NEIGHBOURS_FEW ? 0.2 : 1;
  return mean([[own, 1], [around, weight]]);
}

// -1 calm .. 1 lively, or null when none of the tags says.
function energyOf(vector) {
  if (!vector) return null;
  let sum = 0;
  let weight = 0;
  for (const [tag, w] of vector) {
    if (!(tag in ENERGY) || w <= 0) continue;
    sum += ENERGY[tag] * w;
    weight += w;
  }
  return weight > 0.15 ? sum / weight : null;
}

module.exports = { vectorOf, cosine, mean, blend, energyOf, keyOf, COUNT_MIN };
