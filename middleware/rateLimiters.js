const rateLimit = require("express-rate-limit");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const settingsWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Analytics JSON endpoints (period switches on the dashboards). Cheap individually - the clouds
// are served from wordStatsRepo's TTL cache - but they are the only routes an anonymous visitor
// can call in a tight loop, so they get a ceiling.
const statsReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
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
});

module.exports = { authLimiter, settingsWriteLimiter, statsReadLimiter, searchLimiter };
