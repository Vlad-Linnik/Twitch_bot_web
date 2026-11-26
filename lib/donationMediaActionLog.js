// The donation media action log: which person did what to a channel's queue, from the panel on the
// site, the OBS dock or chat. The pure half - what a command amounted to; the rows are
// db/donationMediaActionsRepo.js's, the writing is realtime/donationMediaManager.js's.
//
// A command is logged by what it changed, not by having been sent: capture() before it runs,
// entryOf() after. A second "pause" on a paused clip, or a command about a clip already gone,
// leaves no entry.
//
// An entry: { action, video?, detail? } - `video` { videoId, title } is the clip it was about (for a
// skip, the one skipped), `detail` the rest (a volume, a place in the queue, a wish's text...).
const { extractVideoId } = require("./donationMedia");

// Commands that answer only after asking the outside; everything else is done when the command
// handler first yields.
const SLOW = new Set(["radioStart", "moreFromArtist", "aiWish", "dislike"]);

// A slider or a drag sends a series of values, and only where it ended up is worth a row: such an
// action continues the same person's previous row about the same clip within this long.
const COALESCE_MS = 15 * 1000;
const COALESCED = new Set(["volume", "blur", "seek"]);

const videoOf = (item) => (item && item.videoId ? { videoId: item.videoId, title: item.title || "" } : null);
const orderOf = (list) => list.map((i) => i.id).join(",");

function listOf(queue, type) {
  if (type === "remove" || type === "moveTop" || type === "move") return queue.queue;
  if (type === "replay") return queue.history;
  if (type === "playlistRemove") return queue.playlist;
  if (type === "upNextRemove" || type === "upNextMove" || type === "upNextPlay") return queue.upNext;
  return [];
}

// `placeholder`: the picture picked just then (the manager's, not the queue's).
function capture(queue, msg, placeholder = null) {
  const list = listOf(queue, msg.type);
  return {
    current: queue.current ? { ...queue.current } : null,
    paused: queue.paused,
    cover: queue.cover,
    placeholder,
    volume: queue.volume,
    blur: queue.blurStrength,
    autoPlaylist: queue.autoPlaylist,
    infinite: queue.infinite,
    hideMusic: queue.hideMusic,
    musicMode: { ...queue.musicMode },
    radio: queue.radio ? { ...queue.radio.seed } : null,
    history: queue.history.length,
    upNext: queue.upNext.length,
    nextItemId: queue.nextItemId,
    target: { ...(list.find((i) => i.id === msg.id) || {}) },
    order: orderOf(list),
  };
}

// What the command did, or null for nothing. `reply`: what the panel was answered, if anything.
function entryOf(msg, before, queue, { reply = null, placeholder = null } = {}) {
  const list = listOf(queue, msg.type);
  const target = videoOf(before.target);
  const gone = target && !list.some((i) => i.id === msg.id);
  const moved = target && orderOf(list) !== before.order;
  const about = (action, detail) => ({ action, video: videoOf(before.current), ...(detail ? { detail } : {}) });
  const toggle = (key) => (before[key] === queue[key] ? null : { action: key, detail: { on: queue[key] } });
  // The clip a link in the command points at; its name, when the panel saw it somewhere.
  const linked = (detail, action = msg.type) => {
    const videoId = extractVideoId(String(msg.url || "").slice(0, 300));
    if (!videoId || !reply || !reply.ok) return null;
    const known = [before.current, queue.current, ...queue.queue, ...queue.history, ...queue.playlist, ...queue.upNext, ...(queue.disliked || [])].find((i) => i && i.videoId === videoId && i.title);
    return { action, video: { videoId, title: known ? known.title : reply.title || "" }, ...(detail ? { detail } : {}) };
  };

  switch (msg.type) {
    case "pause":
      return !before.paused && queue.paused ? about("pause") : null;
    case "resume":
      return before.paused && !queue.paused && before.current ? about("resume") : null;
    case "skip":
      return before.current ? about("skip") : null;
    case "seek": {
      if (!before.current) return null;
      const time = Math.max(0, Math.floor(Number(msg.time) || 0));
      return time === 0 ? about("restart") : about("seek", { time });
    }
    case "replay":
      return target && queue.nextItemId !== before.nextItemId ? { action: msg.next === true ? "playNext" : "requeue", video: target } : null;
    case "remove":
      return gone ? { action: "remove", video: target } : null;
    case "moveTop":
    case "move":
      return moved ? { action: "move", video: target, detail: { place: list.findIndex((i) => i.id === msg.id) + 1 } } : null;
    case "clearHistory":
      return before.history > 0 && queue.history.length === 0 ? { action: "clearHistory" } : null;
    case "cover":
      if (!before.current || (before.cover === queue.cover && before.placeholder === placeholder)) return null;
      return about("cover", { mode: queue.cover || "none" });
    case "blurStrength":
      return before.blur === queue.blurStrength ? null : { action: "blur", detail: { value: queue.blurStrength } };
    case "volume":
      return before.volume === queue.volume ? null : { action: "volume", detail: { value: queue.volume } };
    case "autoPlaylist":
    case "infinite":
    case "hideMusic":
      return toggle(msg.type);
    case "musicMode": {
      const detail = {};
      for (const key of ["novelty", "mood"]) if (before.musicMode[key] !== queue.musicMode[key]) detail[key] = queue.musicMode[key];
      return Object.keys(detail).length ? { action: "musicMode", detail } : null;
    }
    case "playlistRemove":
      return gone ? { action: "playlistRemove", video: target } : null;
    case "playlistAdd":
    case "add":
      return linked();
    case "like":
      return linked(null, reply && reply.liked === false ? "unlike" : "like");
    case "dislike":
      return linked(null, reply && reply.disliked === false ? "undislike" : "dislike");
    case "radioStart":
    case "moreFromArtist":
      return linked({ added: reply ? reply.added || 0 : 0 });
    case "radioStop":
      return before.radio && !queue.radio ? { action: "radioStop", video: videoOf(before.radio) } : null;
    case "aiWish":
      return reply && reply.ok ? { action: "aiWish", detail: { text: String(msg.text || "").trim().slice(0, 200), added: reply.added || 0 } } : null;
    case "upNextRemove":
      return gone ? { action: "upNextRemove", video: target } : null;
    case "upNextMove":
      return moved ? { action: "upNextMove", video: target, detail: { place: list.findIndex((i) => i.id === msg.id) + 1 } } : null;
    case "upNextPlay":
      return target ? { action: "upNextPlay", video: target } : null;
    case "upNextClear":
      return before.upNext > 0 ? { action: "upNextClear", detail: { count: before.upNext } } : null;
    default:
      return null;
  }
}

// The panel command a `!clip` action amounts to.
function commandOfChat(action) {
  if (action === "hide") return { type: "cover", mode: "hide" };
  if (action === "show") return { type: "cover", mode: null };
  if (action === "play") return { type: "resume" };
  return { type: action };
}

// Does `next` continue the row `prev` ({ by, via, action, video, at })?
function continues(prev, next) {
  return Boolean(
    prev &&
      COALESCED.has(next.action) &&
      prev.action === next.action &&
      prev.by === next.by &&
      prev.via === next.via &&
      (prev.video ? prev.video.videoId : null) === (next.video ? next.video.videoId : null) &&
      next.at - prev.at <= COALESCE_MS
  );
}

// Every `action` an entry may carry, for the strings test.
const ACTIONS = [
  "pause", "resume", "skip", "restart", "seek", "playNext", "requeue", "remove", "move", "clearHistory", "cover", "blur", "volume",
  "autoPlaylist", "infinite", "hideMusic", "musicMode", "playlistAdd", "playlistRemove", "like", "unlike", "dislike", "undislike", "add", "radioStart", "radioStop", "moreFromArtist",
  "aiWish", "upNextRemove", "upNextMove", "upNextPlay", "upNextClear", "songRequest", "placeholderAdd", "placeholderRemove",
];

module.exports = { capture, entryOf, commandOfChat, continues, isSlow: (type) => SLOW.has(type), ACTIONS, COALESCE_MS };
