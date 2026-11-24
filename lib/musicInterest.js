// The music graph's other graph: which songs the viewers took an interest in. A viewer who writes the
// channel's "what is playing" command (!song) while a song plays has asked about it. Songs are nodes;
// two songs the same viewers asked about are joined, the more of them the stronger. It is kept apart
// from the channel's taste and changes nothing of what plays: people ask about a bad song too, and the
// journal (lib/musicJournal.js) is where it shows whether they mean it. Pure; db/musicInterestRepo.js
// reads the chat and stores it.
const { isKnownBotName } = require("../config/knownBots");

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The same reading of a message as the bot's: the command first, or after "@someone "
// (TwitchBot shared/mentionRedirect.js, config/channelSettings.js getCommandSignatureRegex).
function commandTest(signature) {
  const command = new RegExp(`^${escape(String(signature || "").toLowerCase())}(?:\\s|$)`);
  return (message) => {
    const text = String(message || "").trim();
    const redirect = text.match(/^@\w+\s+(!.+)$/s);
    return command.test((redirect ? redirect[1] : text).toLocaleLowerCase());
  };
}

// messages: rows of the bot's `messages` while a song played. Returns { askers: [userId], chat: { n, users,
// emotes } } - emotes: how many of the messages have one of `emotes` (a Set of words). Not counted: bots,
// the streamer asking, and lines of somebody else's chat (a shared chat's sourceRoomId).
function readChat(messages, { channelId, signature, emotes = new Set() }) {
  const asks = commandTest(signature);
  const askers = new Set();
  const users = new Set();
  let n = 0;
  let withEmote = 0;
  for (const m of messages) {
    if ((m.sourceRoomId && String(m.sourceRoomId) !== String(channelId)) || isKnownBotName(m.userName)) continue;
    n++;
    const user = String(m.userId || "");
    users.add(user);
    if (signature && asks(m.message)) {
      if (user && user !== String(channelId)) askers.add(user);
    } else if (String(m.message || "").split(/\s+/).some((w) => emotes.has(w))) withEmote++;
  }
  return { askers: [...askers], chat: { n, users: users.size, emotes: withEmote } };
}

// rows: { userId, id, videoId, title, author, n, lastAt }, one per viewer and song. Returns
//   songs [{ id, videoId, title, author, askers, times, lastAt }], the most asked about first
//   links [{ a, b, shared, weight }] - ids; weight: shared viewers against how many asked about either
// A viewer who asks about everything joins everything to everything, so each of them counts the less the
// more songs they asked about.
const LINK_SONGS_MAX = 60;
function graphOf(rows, { limit = 300, links: linkLimit = 3000 } = {}) {
  const songs = new Map();
  const byViewer = new Map();
  for (const r of rows) {
    const song = songs.get(r.id) || { id: r.id, videoId: r.videoId, title: r.title || "", author: r.author || "", askers: 0, times: 0, lastAt: 0 };
    song.askers++;
    song.times += r.n || 1;
    song.lastAt = Math.max(song.lastAt, r.lastAt ? new Date(r.lastAt).getTime() : 0);
    songs.set(r.id, song);
    if (!byViewer.has(r.userId)) byViewer.set(r.userId, []);
    byViewer.get(r.userId).push(r.id);
  }
  const top = [...songs.values()].sort((a, b) => b.askers - a.askers || b.times - a.times || b.lastAt - a.lastAt).slice(0, limit);
  const shown = new Set(top.map((s) => s.id));
  const pairs = new Map();
  for (const ids of byViewer.values()) {
    const own = [...new Set(ids)].filter((id) => shown.has(id)).slice(0, LINK_SONGS_MAX).sort();
    if (own.length < 2) continue;
    const share = 1 / Math.log2(1 + own.length);
    for (let i = 0; i < own.length; i++) {
      for (let j = i + 1; j < own.length; j++) {
        const key = `${own[i]}\n${own[j]}`;
        const pair = pairs.get(key) || { a: own[i], b: own[j], shared: 0, sum: 0 };
        pair.shared++;
        pair.sum += share;
        pairs.set(key, pair);
      }
    }
  }
  const links = [...pairs.values()]
    .map(({ a, b, shared, sum }) => ({ a, b, shared, weight: sum / Math.sqrt(songs.get(a).askers * songs.get(b).askers) }))
    .sort((x, y) => y.shared - x.shared || y.weight - x.weight)
    .slice(0, linkLimit);
  return { songs: top, links, viewers: byViewer.size, total: songs.size };
}

module.exports = { commandTest, readChat, graphOf };
