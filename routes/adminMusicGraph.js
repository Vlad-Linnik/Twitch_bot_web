// The site admin's view of the donation media radio's music graph (lib/musicGraph.js): what it knows,
// what it would play and why. Read-only, and it never asks YouTube or Last.fm for anything - it shows
// the live radio's graph, or what Mongo has around a track.
const express = require("express");
const { requireLevel } = require("../middleware/permissions");
const channelsRepo = require("../db/channelsRepo");
const musicGraphRepo = require("../db/musicGraphRepo");
const donationMediaManager = require("../realtime/donationMediaManager");
const { MusicRadio } = require("../lib/musicRadio");
const { songId } = require("../lib/musicGraph");
const { describe } = require("../lib/musicGraphView");

const router = express.Router();
const requireAdmin = requireLevel(0);

const STRING_KEYS = [
  "loading", "failed", "empty", "nothingFound", "live", "stored", "total", "opened", "close", "streak", "close2", "far", "closeness", "share", "taste", "rested", "plays",
  "lastPlayed", "never", "via", "edges", "openTrack", "around", "notOpened", "wontPlay", "supply.graph", "supply.mix", "supply.grow", "supply.lastfm", "supply.artist", "supply.oembed", "sources", "noStats", "skipShare",
  "state.root", "state.playing", "state.waiting", "state.liked", "state.disliked", "state.closed", "state.heard", "state.unheard",
];
// A channel with nothing playing is shown from the songs it heard to the end last.
const STORED_ROOTS = 5;
const STATS_DAYS = 14;

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

// ?channel=<id>  whose taste; ?q=<words or a video id>  around this track instead of the live radio.
router.get("/admin/music-graph/data", requireAdmin, async (req, res, next) => {
  try {
    const channelId = typeof req.query.channel === "string" && /^\d{1,20}$/.test(req.query.channel) ? req.query.channel : "0";
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const session = donationMediaManager.musicOf(channelId);
    const stats = await musicGraphRepo.statsSince(channelId, STATS_DAYS);
    const reply = (graph, roots, extra) => res.json({ ...describe(graph, roots, { songId, ...extra.queue }), live: extra.live, root: extra.root || null, stats });

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
