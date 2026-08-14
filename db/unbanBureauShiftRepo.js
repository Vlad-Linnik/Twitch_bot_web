// `UnbanBureauShifts` — one moderator per channel at the review desk.
//
// Two moderators working the same queue at once is not a cosmetic problem: they hand out real
// Twitch verdicts, the chat vote is a single per-channel bot-side tally (TwitchBot's
// games/unbanVote.js keys it by CHANNEL — see ../CLAUDE.md), and the loudspeaker advances a queue
// they'd each be seeing a different slice of. So the desk is leased: whoever opens the page first
// holds the shift, and everyone else is turned away until it ends.
//
// WEB-ONLY (connectWeb): the bot never reads this. It is presence, not moderation state.
//
// The lease is time-based rather than released-on-exit, because a closed laptop, a crashed tab or a
// dropped connection would otherwise wedge a channel's desk shut forever. The page renews while it
// is open (see routes/unbanBureau.js's shift.json) and gives the lease back explicitly on pagehide;
// the TTL is only the backstop for when it can't.
const { connectWeb } = require("./connection");

// Renewal is every SHIFT_HEARTBEAT_MS on the client. The lease has to outlive a few missed
// heartbeats (a backgrounded tab throttles timers) but stay short enough that a colleague isn't
// locked out for long after a crash.
const SHIFT_LEASE_MS = 90 * 1000;
const SHIFT_HEARTBEAT_MS = 25 * 1000;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UnbanBureauShifts");
  // Housekeeping only — every query below compares expiresAt itself, because Mongo's TTL monitor
  // runs about once a minute and a lease must be takeable the instant it lapses.
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 300 });
  return collection;
}

function holderOf(doc) {
  if (!doc) return null;
  return {
    userId: String(doc.userId),
    login: doc.login,
    displayName: doc.displayName || doc.login,
    startedAt: doc.startedAt,
    expiresAt: doc.expiresAt,
  };
}

// Takes the shift, or renews it if this user already holds it. Returns
// `{ ok: true, holder }` for the holder, `{ ok: false, holder }` for anyone else.
//
// The _id IS the channel login, which is what makes this atomic without a transaction: the upsert
// either matches the holder's own (or a lapsed) document and rewrites it, or collides with the live
// one on the primary key. There is no window in which two callers both think they won.
async function acquire(channelLogin, user, attempt = 0) {
  const col = await ensureInitialized();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHIFT_LEASE_MS);
  try {
    const doc = await col.findOneAndUpdate(
      {
        _id: channelLogin,
        $or: [{ userId: String(user.userId) }, { expiresAt: { $lte: now } }],
      },
      // An update PIPELINE rather than a plain $set/$setOnInsert pair, because startedAt has to
      // survive a renewal and reset on a takeover — and $setOnInsert can't tell those apart: taking
      // over a lapsed lease rewrites an existing document, so it would have kept the PREVIOUS
      // moderator's start time and the busy page would report a shift that never happened.
      [
        {
          $set: {
            userId: String(user.userId),
            login: user.login,
            displayName: user.displayName || user.login,
            expiresAt,
            startedAt: {
              $cond: [
                { $eq: ["$userId", String(user.userId)] },
                { $ifNull: ["$startedAt", now] },
                now,
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after" }
    );
    return { ok: true, holder: holderOf(doc) };
  } catch (err) {
    // Duplicate key = the filter didn't match, so a document exists and it is somebody else's live
    // lease. Anything else is a real failure and must not read as "busy".
    if (err && err.code === 11000) {
      const doc = await col.findOne({ _id: channelLogin });
      // Lapsed between the upsert and this read (or released outright) — retry rather than turning
      // this moderator away on a lease nobody holds. Bounded: a third collision means someone else
      // is genuinely winning the race, and reporting them as busy is the correct answer.
      if ((!doc || doc.expiresAt <= new Date()) && attempt < 2) {
        return acquire(channelLogin, user, attempt + 1);
      }
      if (!doc) return { ok: false, holder: null };
      return { ok: false, holder: holderOf(doc) };
    }
    throw err;
  }
}

// Whoever currently holds the desk, or null. Read-only — never takes the shift.
async function current(channelLogin) {
  const col = await ensureInitialized();
  const doc = await col.findOne({ _id: channelLogin, expiresAt: { $gt: new Date() } });
  return holderOf(doc);
}

// True if this user holds the shift right now. The write endpoints gate on it, so a page left open
// from before the lease was lost can't keep stamping verdicts.
async function holds(channelLogin, userId) {
  const holder = await current(channelLogin);
  return Boolean(holder && holder.userId === String(userId));
}

// Takes the desk regardless of who holds it. The escape hatch for the one failure the lease cannot
// resolve on its own: a moderator whose tab is genuinely still renewing (see the visibility rule in
// public/js/games/unban-bureau.js) but who is not at it.
//
// Route-gated to the channel owner and site admins - NOT to tier-2 moderators, who would otherwise
// be able to eject each other, which is the thing the lease exists to prevent. The eviction is
// written to SettingsChangeLog by the caller, because unlike every other shift transition this one
// takes something away from a named colleague.
//
// No filter and no upsert race to worry about: _id is the channel login, so this either replaces
// the live document or creates the only one there can be.
async function forceAcquire(channelLogin, user) {
  const col = await ensureInitialized();
  const now = new Date();
  const previous = await col.findOne({ _id: channelLogin });
  const doc = await col.findOneAndUpdate(
    { _id: channelLogin },
    {
      $set: {
        userId: String(user.userId),
        login: user.login,
        displayName: user.displayName || user.login,
        startedAt: now,
        expiresAt: new Date(now.getTime() + SHIFT_LEASE_MS),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return { holder: holderOf(doc), previous: holderOf(previous) };
}

// Explicit hand-back on pagehide. Scoped by userId so a stale beacon from a moderator whose lease
// already rolled over to a colleague can't end the colleague's shift.
async function release(channelLogin, userId) {
  const col = await ensureInitialized();
  const result = await col.deleteOne({ _id: channelLogin, userId: String(userId) });
  return result.deletedCount > 0;
}

module.exports = {
  acquire,
  forceAcquire,
  current,
  holds,
  release,
  SHIFT_LEASE_MS,
  SHIFT_HEARTBEAT_MS,
};
