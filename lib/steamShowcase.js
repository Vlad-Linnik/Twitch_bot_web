// Reads a Steam profile's Item Showcase, for the throne theme's display case
// (views/partials/throneShowcase.ejs, edited at /admin/page-themes/:userId).
//
// There is no API behind this. Steam's Web API has endpoints for profile summaries, owned games
// and inventories, but none for profile SHOWCASES - what a person chose to put on display exists
// only in the profile page's HTML. So this parses the page, the same class of dependency as
// TwitchBot/twitch/gqlClient.js, and carries the same rule: an empty result is normal. Steam can
// change its markup, make a profile private, or rename a vanity URL at any moment, and none of
// those may do more than leave the case empty.
//
// The pure half (parseProfileUrl, parseShowcase) is what tests/steamShowcase.test.js covers; the
// fetching half is a thin wrapper around it.

// Only steamcommunity.com, only the two profile shapes, only https. This URL comes from a form
// and is then fetched BY THE SERVER, which makes it an SSRF surface: without this gate an admin
// (or anything that ever gets to write the field) could point the fetcher at localhost, at the
// cloud metadata endpoint, or at any internal host. Everything else about the input is dropped.
const PROFILE_PATTERN = /^https?:\/\/steamcommunity\.com\/(id|profiles)\/([A-Za-z0-9_.-]{2,64})\/?$/;

// Steam serves showcase art from its own CDN hosts. They are listed so the image sync can refuse
// to download from anywhere else - the URLs come out of scraped HTML, which is attacker-adjacent
// input the moment Steam is compromised or the profile embeds something unexpected.
const IMAGE_HOSTS = new Set([
  "community.fastly.steamstatic.com",
  "community.akamai.steamstatic.com",
  "community.cloudflare.steamstatic.com",
  "steamcommunity-a.akamaihd.net",
]);

// Steam's own item showcase tops out at 10 slots. The cap is here so a malformed or hostile page
// can't hand us a thousand items to download.
const MAX_ITEMS = 12;

const REQUEST_TIMEOUT_MS = 8000;

// Accepts what a person would actually paste - with or without scheme, with or without a
// trailing slash - and returns the canonical form, or null if it isn't a Steam profile at all.
function parseProfileUrl(input) {
  let raw = (input ?? "").toString().trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  raw = raw.replace(/^http:\/\//i, "https://").replace(/\?.*$/, "").replace(/#.*$/, "");

  const match = PROFILE_PATTERN.exec(raw);
  if (!match) return null;
  const [, kind, handle] = match;
  // /profiles/ takes a 64-bit numeric id and nothing else; /id/ takes a vanity name.
  if (kind === "profiles" && !/^[0-9]{17}$/.test(handle)) return null;
  return `https://steamcommunity.com/${kind}/${handle}`;
}

function isAllowedImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && IMAGE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// One showcase slot in the profile markup: a border colour (Steam's rarity colour), the
// classinfo triple that identifies the item type, and the artwork.
const SLOT_PATTERN =
  /<div class="showcase_slot item_showcase_item[^"]*"[^>]*?style="border-color:\s*([^;"]+)[^"]*"[^>]*?data-economy-item="classinfo\/([0-9]+)\/([0-9]+)(?:\/([0-9]+))?"[^>]*>\s*<a[^>]*>\s*<img[^>]+src="([^"]+)"/g;

// Items only - the profile page carries other showcases (screenshots, badges, groups) whose
// markup this pattern deliberately does not match.
function parseShowcase(html) {
  const source = (html ?? "").toString();
  const items = [];
  const seen = new Set();

  SLOT_PATTERN.lastIndex = 0;
  let match;
  while ((match = SLOT_PATTERN.exec(source)) !== null) {
    const [, borderColor, appId, classId, instanceId, imageUrl] = match;
    if (!isAllowedImageUrl(imageUrl)) continue;
    // Slots are kept in profile order INCLUDING duplicates - a showcase filled with nine copies
    // of one item is a statement its owner made on purpose, and collapsing it to one tile would
    // be us editing their showcase rather than showing it.
    items.push({
      appId,
      classId,
      instanceId: instanceId || null,
      // Lowercased hex, so the view can drop it straight into a style attribute after the
      // validator has checked it.
      borderColor: /^#[0-9A-Fa-f]{6}$/.test(borderColor.trim()) ? borderColor.trim().toLowerCase() : null,
      imageUrl,
      name: null,
    });
    seen.add(`${appId}/${classId}/${instanceId || ""}`);
    if (items.length >= MAX_ITEMS) break;
  }

  return items;
}

// The item's display name, which the profile page does not carry. Steam's hover endpoint returns
// a fragment of markup with a JSON payload inside it; only the name and the rarity line are
// taken, and a miss is not an error - a nameless tile still shows the artwork.
function parseHoverName(body) {
  const source = (body ?? "").toString();
  const name = /"market_name":"((?:[^"\\]|\\.)*)"/.exec(source) || /"name":"((?:[^"\\]|\\.)*)"/.exec(source);
  if (!name) return null;
  try {
    return JSON.parse(`"${name[1]}"`);
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      // Steam serves a stripped page to obvious bots; this is a plain desktop UA, not an attempt
      // to look like a person - the volume here is a handful of requests per manual re-sync.
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en",
    },
  });
  if (!response.ok) throw new Error(`steam responded ${response.status}`);
  return response.text();
}

// Profile -> items with names. Names are resolved per DISTINCT item, not per slot: a showcase of
// nine copies of one item costs one extra request, not nine.
async function fetchShowcase(profileUrl) {
  const canonical = parseProfileUrl(profileUrl);
  if (!canonical) throw new Error("not a steam profile url");

  const items = parseShowcase(await fetchText(canonical));
  if (items.length === 0) return { profileUrl: canonical, items: [] };

  const names = new Map();
  for (const item of items) {
    const key = `${item.appId}/${item.classId}/${item.instanceId || ""}`;
    if (names.has(key)) continue;
    const hoverUrl =
      `https://steamcommunity.com/economy/itemclasshover/${item.appId}/${item.classId}` +
      (item.instanceId ? `/${item.instanceId}` : "") +
      "?content_only=1&l=english";
    try {
      names.set(key, parseHoverName(await fetchText(hoverUrl)));
    } catch {
      // A name is decoration on top of the artwork; failing to get one must not fail the sync.
      names.set(key, null);
    }
  }

  return {
    profileUrl: canonical,
    items: items.map((item) => ({
      ...item,
      name: names.get(`${item.appId}/${item.classId}/${item.instanceId || ""}`) || null,
    })),
  };
}

module.exports = {
  MAX_ITEMS,
  IMAGE_HOSTS,
  parseProfileUrl,
  isAllowedImageUrl,
  parseShowcase,
  parseHoverName,
  fetchShowcase,
};
