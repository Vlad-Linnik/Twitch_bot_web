// The music graph's third graph: the clips viewers paid for. Clips are nodes; two clips the same donors
// ordered are joined. Like the viewers' interest (lib/musicInterest.js, whose graphOf builds it) it is
// kept apart from the channel's taste and changes nothing of what plays. Pure;
// db/musicDonationsRepo.js stores it.
const crypto = require("crypto");
const { songId } = require("./musicGraph");
const { isDonation } = require("./donationMediaQueue");

// A platform's name for a donor who gave none.
const NAMELESS = new Set(["", "аноним", "анонимно", "анонім", "anonymous", "anonym", "anon"]);

// Donors have a name they typed, not an id. Only a hash of it is kept: it tells donors apart, and no
// page has to show who paid for what. null: nameless, and so nobody's other clip.
function donorKey(channelId, name) {
  const clean = String(name || "").normalize("NFKC").trim().toLowerCase();
  if (NAMELESS.has(clean)) return null;
  return crypto.createHash("sha256").update(`${channelId}\n${clean}`).digest("hex").slice(0, 24);
}

// The row of a clip that ended, or null for one that is not counted: not a donation, a moderator's
// repeat of one, never shown (removed from the queue, refused by YouTube). `key` is the same however
// often the clip is looked at, so the history can be read again at every start.
function donationOf(channelId, item, { status, at, author = "" }) {
  if (!isDonation(item) || item.replay || (status !== "played" && status !== "skipped") || !item.videoId) return null;
  return {
    channelId: String(channelId),
    key: `${item.addedAt}:${item.videoId}`,
    donor: donorKey(channelId, item.donor),
    videoId: item.videoId,
    title: item.title || "",
    author,
    skipped: status === "skipped",
    at: new Date(at),
  };
}

// Rows for graphOf: one per donor and song. The song's id is worked out here and not stored: a clip's
// channel may be known for one of its donations only, and all of them are one song.
function rowsOf(docs) {
  const names = new Map();
  for (const d of docs) {
    const known = names.get(d.videoId);
    if (!known || (!known.author && d.author) || (!known.title && d.title)) names.set(d.videoId, { videoId: d.videoId, title: d.title || (known && known.title) || "", author: d.author || (known && known.author) || "" });
  }
  const rows = new Map();
  docs.forEach((d, i) => {
    const song = names.get(d.videoId);
    const id = songId(song);
    const userId = d.donor || `nameless ${i}`;
    const row = rows.get(`${userId}\n${id}`) || { userId, id, ...song, n: 0, lastAt: 0 };
    row.n++;
    row.lastAt = Math.max(row.lastAt, new Date(d.at).getTime());
    rows.set(`${userId}\n${id}`, row);
  });
  return [...rows.values()];
}

module.exports = { donorKey, donationOf, rowsOf };
