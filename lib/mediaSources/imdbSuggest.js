// The no-key fallback for films and series, used only while TMDB_READ_TOKEN is not set: IMDb's own
// search box endpoint, plus Wikidata for the Russian title.
//
// The suggestion endpoint is undocumented - the same class of dependency as the bot's private
// Twitch GraphQL, with the same rule: "nothing found" is a normal answer, and manual entry is always
// there. It understands a Russian query but answers in English, hence Wikidata: an IMDb id resolves
// to an item (haswbstatement:P345) whose Russian label is the title. Wikidata failing only means
// the English title stays.
const { getJson, str } = require("./http");

const SUGGEST = "https://v3.sg.media-imdb.com/suggestion/x";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const KINDS = { movie: "film", tvMovie: "film", tvSeries: "series", tvMiniSeries: "series" };

// Amazon image URLs carry their size in the file name; "._V1_SX300.jpg" asks for 300 px wide.
function sizedImage(url, width) {
  if (typeof url !== "string" || !/^https:\/\/m\.media-amazon\.com\/images\/M\/[\w@%.,-]+\.jpg$/.test(url)) return null;
  return url.replace(/\._V1_[^/]*\.jpg$/, `._V1_SX${width}.jpg`);
}

function normalize(x) {
  if (!x || !/^tt\d{7,10}$/.test(x.id) || !KINDS[x.qid]) return null;
  const title = str(x.l);
  if (!title) return null;
  return {
    ref: `imdb:${x.id}`,
    source: "imdb",
    title,
    originalTitle: null,
    year: Number.isInteger(x.y) ? x.y : null,
    mediaType: KINDS[x.qid],
    previewUrl: sizedImage(x.i?.imageUrl, 92),
    posterUrl: sizedImage(x.i?.imageUrl, 600),
  };
}

function createImdbSuggestSource({ fetchImpl } = {}) {
  async function russianTitle(imdbId) {
    try {
      const found = await getJson(
        `${WIKIDATA}?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P345=${imdbId}`)}&srlimit=1&format=json`,
        { fetchImpl, timeoutMs: 4000 }
      );
      const qid = found?.query?.search?.[0]?.title;
      if (!/^Q\d+$/.test(qid || "")) return null;
      const entity = await getJson(`${WIKIDATA}?action=wbgetentities&ids=${qid}&props=labels&languages=ru&format=json`, { fetchImpl, timeoutMs: 4000 });
      return str(entity?.entities?.[qid]?.labels?.ru?.value);
    } catch {
      return null;
    }
  }

  async function lookup(query) {
    const body = await getJson(`${SUGGEST}/${encodeURIComponent(query.toLowerCase())}.json`, { fetchImpl });
    return (body.d || []).map(normalize).filter(Boolean);
  }

  return {
    key: "imdb",
    async search(query) {
      return (await lookup(query)).slice(0, 12).map(({ posterUrl, ...rest }) => rest);
    },
    async details(id) {
      if (!/^tt\d{7,10}$/.test(String(id))) return null;
      const hit = (await lookup(id)).find((x) => x.ref === `imdb:${id}`);
      if (!hit) return null;
      const ru = await russianTitle(id);
      return {
        ...hit,
        title: ru || hit.title,
        originalTitle: ru && ru !== hit.title ? hit.title : null,
        imdbId: id,
        episodes: null,
        nsfwHint: false,
        external: {},
      };
    },
  };
}

module.exports = { createImdbSuggestSource, normalize, sizedImage };
