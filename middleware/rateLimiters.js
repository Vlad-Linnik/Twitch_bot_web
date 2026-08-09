const rateLimit = require("express-rate-limit");
const adminAllowlist = require("../db/adminAllowlist");

// Tier-0 app developers (ADMIN_USER_IDS) are trusted operators, not the anonymous/low-trust
// traffic these buckets exist to bound - and the admin panel's own bulk actions (e.g. deleting
// many settings-log rows in one go) can legitimately blow through a 10/min ceiling meant for
// per-channel settings writes. Every express-rate-limit bucket below skips counting for them.
function skip(req) {
  return Boolean(req.user?.userId) && adminAllowlist.isAdmin(req.user.userId);
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

const settingsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Settings-type forms autosave on every change (public/js/autosave.js), so they need
// more headroom than settingsWriteLimiter's 10/min - and a SEPARATE bucket, so a burst
// of autosaves can't starve the explicit action buttons (add/delete word, command,
// counter) that stay on settingsWriteLimiter. The client debounces and coalesces
// in-flight saves, so 30/min is generous in practice.
const autosaveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Starting a solo-game run and submitting its score get their own buckets
// rather than sharing settingsWriteLimiter: that one is the explicit-action
// budget for word/command/counter CRUD, and a player finishing a few games
// should not be able to eat it. Both are per-IP like every other
// express-rate-limit bucket here, so they bound automation, not legitimate
// play - the actual anti-cheat is the run token plus server-side replay
// (lib/gameReplay/), not a request ceiling.
const gameRunStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Higher than run starts because one run legitimately produces several POSTs:
// mid-run checkpoints (falling-blocks, 2048) plus the final submit, and a
// retried submit after a lost response.
const gameScoreSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Analytics JSON endpoints (period switches on the dashboards). Cheap individually - the clouds
// are served from wordStatsRepo's TTL cache - but they are the only routes an anonymous visitor
// can call in a tight loop, so they get a ceiling.
const statsReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Log search is the one genuinely expensive read on the site: fuzzy matching scans candidate
// messages in Node, and even the exact path runs a regex over an indexed slice. It is
// moderator-only, so a low ceiling costs legitimate users nothing while bounding what a
// compromised mod account (or an over-eager search box) can do to a 2GB VPS.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// /admin/api/* is bearer-token gated (middleware/adminApiAuth.js), not session-based, so `skip`
// above never applies here (req.user is never set on this path) - this is the route's only
// throttle. 30/min per IP is generous for a handful of ad-hoc lookups but bounds brute-forcing
// the token via raw request volume (the token compare itself is already constant-time).
const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// express-rate-limit is request/response-shaped (reads req, increments via its
// store per matched HTTP request) and doesn't fit a WebSocket message handler,
// which never goes through Express's request cycle. Pulling in a second
// rate-limiting dependency for one low-frequency action (multiplayer Durak
// room creation) would fight the library rather than use it, and contradicts
// the lean/2GB-VPS philosophy above. This is a tiny hand-rolled fixed-window
// counter instead - one Map, a periodic unref'd sweep, no dependency. Keep it
// this minimal; it's meant for occasional actions like "create a room", not a
// general-purpose limiter.
function createSimpleLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return function allow(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
}

// 5 rooms per 10 minutes per user - room creation is a one-off lobby action,
// not something a legitimate player does repeatedly in a short window.
const durakRoomCreateLimiter = createSimpleLimiter({ windowMs: 10 * 60 * 1000, max: 5 });

// Sticker reactions are a chat-adjacent, low-stakes action (unlike a game
// move, sending one never changes room state) - 4 per 8s per user is enough
// to react to a beaten bout or a good bluff without letting one seat spam the
// board for everyone else at the table.
const durakStickerLimiter = createSimpleLimiter({ windowMs: 8 * 1000, max: 4 });

module.exports = {
  authLimiter,
  settingsWriteLimiter,
  autosaveLimiter,
  gameRunStartLimiter,
  gameScoreSubmitLimiter,
  statsReadLimiter,
  searchLimiter,
  adminApiLimiter,
  durakRoomCreateLimiter,
  durakStickerLimiter,
  // Exported so realtime/quickMatchManager.js can build its own per-game
  // queue-join limiter the same hand-rolled way durakRoomCreateLimiter/
  // durakStickerLimiter already do above, instead of adding yet another
  // named export here per new game.
  createSimpleLimiter,
};
