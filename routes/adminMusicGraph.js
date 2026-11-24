// The site admin's view of the donation media radio's music graph (lib/musicGraph.js): what it knows,
// what it would play and why. Read-only, and it never asks YouTube or Last.fm for anything - it shows
// the live radio's graph, what Mongo has around a track, or all of it.
const express = require("express");
const { requireLevel } = require("../middleware/permissions");
const channelsRepo = require("../db/channelsRepo");
const musicGraphRepo = require("../db/musicGraphRepo");
const musicEventsRepo = require("../db/musicEventsRepo");
const { summarize } = require("../lib/musicJournal");
const donationMediaManager = require("../realtime/donationMediaManager");
const { MusicRadio } = require("../lib/musicRadio");
const { songId } = require("../lib/musicGraph");
const { describe, pack } = require("../lib/musicGraphView");

const router = express.Router();
const requireAdmin = requireLevel(0);

const STRING_KEYS = [
  "loading", "failed", "empty", "nothingFound", "live", "stored", "total", "opened", "close", "streak", "close2", "far", "closeness", "share", "taste", "rested", "plays",
  "lastPlayed", "never", "via", "edges", "openTrack", "around", "notOpened", "wontPlay", "supply.graph", "supply.mix", "supply.grow", "supply.lastfm", "supply.artist", "supply.oembed", "sources", "noStats", "skipShare",
  "wholeStatus", "wholeCut", "groupQuery", "groupColor", "removeGroup", "animate", "animateStop", "depthAll", "counts", "closeDetail",
  "journalEmpty", "journalTotal", "journalNotCounted", "reason.offline", "reason.muted", "reason.seeked",
  "cut.source", "cut.mode", "cut.closeness", "cut.novelty", "cut.genre", "cut.place", "cut.hour", "cut.asked",
  "group.radio", "group.endless", "group.feed", "group.playlist", "group.new", "group.known", "group.asked", "group.notAsked",
  "state.root", "state.playing", "state.waiting", "state.liked", "state.disliked", "state.closed", "state.heard", "state.unheard",
];
// A channel with nothing playing is shown from the songs it heard to the end last.
const STORED_ROOTS = 5;
const STATS_DAYS = 14;
// The whole graph: as many of the rows used last as the page can draw. Putting it together takes a
// noticeable part of a second of this process, so one answer serves a minute of looking.
const WHOLE_LIMIT = 4000;
const WHOLE_TTL_MS = 60 * 1000;
const whole = new Map(); // channel id -> { at, reply: Promise }

async function knownChannels() {
  const ids = new Set(await musicGraphRepo.channelsWithTaste());
  // listAll: a channel the bot is switched off on may still have a radio.
  const channels = (await channelsRepo.listAll()).filter((c) => ids.has(String(c.channelId)));
  return channels.map((c) => ({ channelId: String(c.channelId), channelLogin: c.channelLogin })).sort((a, b) => a.channelLogin.localeCompare(b.channelLogin));
}

router.get("/admin/music-graph", requireAdmin, async (req, res, next) => {
  try {
    const t = res.locals.t;
    res.render("adminMusicGraph", {
      tab: "music-graph",
      channels: await knownChannels(),
      statsDays: STATS_DAYS,
      strings: Object.fromEntries(STRING_KEYS.map((k) => [k, t(`admin.graph.${k}`)])),
    });
  } catch (err) {
    next(err);
  }
});

// Where a channel's graph is looked at from: its live radio's roots, else the songs it heard to the end
// last.
async function wholeGraph(channelId, session) {
  const music = new MusicRadio({ channelId, sources: {}, repo: musicGraphRepo });
  await music.load();
  const rows = await musicGraphRepo.loadAll(WHOLE_LIMIT);
  music.absorb(rows);
  const live = session ? session.music.rootsFor(session.queue) : [];
  const roots = live.length > 0 ? live : music.graph.listenedSince(0, STORED_ROOTS).map((r) => ({ ...r, weight: 1 }));
  for (const root of roots) music.graph.addTrack(root);
  const queue = session ? { current: session.queue.current, upNext: session.queue.upNext } : {};
  return { ...pack(describe(music.graph, roots, { songId, ...queue, limit: Infinity })), live: false, whole: true, cut: rows.length === WHOLE_LIMIT, root: null };
}

function wholeOf(channelId, session) {
  const known = whole.get(channelId);
  if (known && Date.now() - known.at < WHOLE_TTL_MS) return known.reply;
  // One at a time in memory: it is megabytes, and only an admin ever looks.
  whole.clear();
  const reply = wholeGraph(channelId, session);
  whole.set(channelId, { at: Date.now(), reply });
  reply.catch(() => whole.delete(channelId));
  return reply;
}

// ?channel=<id>  whose taste; ?q=<words or a video id>  around this track instead of the live radio;
// ?whole=1  everything.
router.get("/admin/music-graph/data", requireAdmin, async (req, res, next) => {
  try {
    const channelId = typeof req.query.channel === "string" && /^\d{1,20}$/.test(req.query.channel) ? req.query.channel : "0";
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const session = donationMediaManager.musicOf(channelId);
    const [stats, events] = await Promise.all([musicGraphRepo.statsSince(channelId, STATS_DAYS), musicEventsRepo.since(channelId, STATS_DAYS)]);
    stats.journal = summarize(events);
    if (req.query.whole === "1") return res.json({ ...(await wholeOf(channelId, session)), stats });
    const reply = (graph, roots, extra) => res.json({ ...pack(describe(graph, roots, { songId, ...extra.queue })), live: extra.live, root: extra.root || null, stats });

    if (!q && session && session.music.graph.nodes.size > 0) {
      const roots = session.music.rootsFor(session.queue);
      return reply(session.music.graph, roots, { live: true, queue: { current: session.queue.current, upNext: session.queue.upNext }, root: roots[0] ? roots[0].title : null });
    }
    const music = new MusicRadio({ channelId, sources: {}, repo: musicGraphRepo });
    await music.load();
    const found = q ? await musicGraphRepo.search(q) : music.graph.listenedSince(0, STORED_ROOTS);
    const roots = found.map((r) => ({ videoId: r.videoId, title: r.title, author: r.author, weight: 1 }));
    for (const root of roots) music.graph.addTrack(root);
    await music.learnKnown(roots);
    reply(music.graph, roots, { live: false, queue: {}, root: roots[0] ? roots[0].title : null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
