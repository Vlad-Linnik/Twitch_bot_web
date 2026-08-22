// `SniperShots` — what the Бюро амнистии review desk fires: a rifle shot, or a grenade.
//
// OWNERSHIP: TwitchBot/db/sniperShotsRepo.js is the origin of this document shape.
//
// This app can only ever write a `pending` REQUEST. It never picks the target: that happens
// bot-side (TwitchBot/twitch/unbanRequestScheduler.js's fireVolley), against the live chatter list,
// with the broadcaster/moderators/known bots filtered out. Keeping the choice server-side is what
// stops this endpoint from being a way to time out a named person on demand — the page can ask for
// "someone", never for "them". Same execute-only-by-bot contract as LongBans and UnbanRequests; see
// ../CLAUDE.md's "Бюро амнистии" section.
//
// `weapon` says which one a row is. 'awp' is the default and what every row written before
// 2026-08-22 is, so a MISSING field reads as 'awp': one drawn victim, reported in
// `targetUserId`/`targetLogin`. 'grenade' takes everyone who spoke in the last 30 seconds and
// reports `targetLogins`/`targetUserIds`/`targetCount`/`hitCount` instead. That choice is the one
// thing the page really does decide — it still cannot name anybody.
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("SniperShots");
  // The bot maintains the same indexes; declared here too so a fresh web deploy against an empty
  // collection isn't waiting on the bot to create them.
  await collection.createIndex({ status: 1, requestedAt: 1 });
  await collection.createIndex({ channelId: 1, requestedAt: -1 });
  return collection;
}

// Records a shot for the bot to fire. `caseId` is only an audit breadcrumb (which appeal was on
// screen at the time); a shot is deliberately NOT tied to a case — the moderator can fire whenever.
async function requestShot(channel, user, caseId, weapon = "awp") {
  const col = await ensureInitialized();
  const doc = {
    channelId: String(channel.channelId),
    channelLogin: channel.channelLogin,
    caseId: caseId || null,
    weapon: weapon === "grenade" ? "grenade" : "awp",
    requestedById: String(user.userId),
    requestedByLogin: user.login,
    requestedByDisplayName: user.displayName || user.login,
    requestedAt: new Date(),
    status: "pending",
    targetUserId: null,
    targetLogin: null,
    mode: null,
    durationSec: null,
    firedAt: null,
    success: null,
  };
  const result = await col.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// When the channel's next grenade is allowed, as a timestamp (null = right now). Channel-wide, not
// per moderator: the blast is channel-wide too, and two moderators taking turns would be exactly
// the spam the cooldown exists to prevent.
//
// Measured from `requestedAt` rather than from when the bot resolved the throw, so a grenade that
// found nobody in chat still spends the cooldown. Otherwise the cheapest way to keep the weapon
// permanently ready would be to throw it into a quiet chat.
async function grenadeReadyAt(channelId, cooldownMs) {
  const col = await ensureInitialized();
  const previous = await col.findOne(
    {
      channelId: String(channelId),
      weapon: "grenade",
      requestedAt: { $gte: new Date(Date.now() - cooldownMs) },
    },
    { sort: { requestedAt: -1 } }
  );
  return previous ? new Date(previous.requestedAt.getTime() + cooldownMs) : null;
}

// Records a grenade, or refuses it because the channel is still on cooldown. Returns
// `{ shot }` or `{ readyAt }`.
//
// The re-check after the insert is not paranoia about a busy site — the desk is shift-locked, so
// there is at most one moderator here — it is about that one moderator double-clicking: two
// requests milliseconds apart both read an empty window before either had written a row. Whoever's
// row is not the earliest in the window withdraws it, which is decided by the same data both
// racers can see rather than by who got there first. Withdrawal is `status: "pending"`-guarded so
// it can never delete a throw the bot has already claimed and fired.
async function requestGrenade(channel, user, caseId, cooldownMs) {
  const col = await ensureInitialized();

  const blockedAt = await grenadeReadyAt(channel.channelId, cooldownMs);
  if (blockedAt) return { readyAt: blockedAt };

  const shot = await requestShot(channel, user, caseId, "grenade");

  const earliest = await col.findOne(
    {
      channelId: String(channel.channelId),
      weapon: "grenade",
      requestedAt: { $gte: new Date(Date.now() - cooldownMs) },
    },
    { sort: { requestedAt: 1, _id: 1 } }
  );
  if (earliest && String(earliest._id) !== String(shot._id)) {
    await col.deleteOne({ _id: shot._id, status: "pending" });
    return { readyAt: new Date(earliest.requestedAt.getTime() + cooldownMs) };
  }

  return { shot };
}

// The most recently RESOLVED shot in this channel, if it resolved inside `windowMs`.
//
// This is how the outcome gets back to the desk, and until 2026-08-14 nothing did: the shot moved
// out of the `UnbanRequests.sniper` sub-document into this collection when it stopped being 1:1
// with a case, but `live.json` kept reading that sub-document — which the bot no longer writes. So
// the page announced "выстрел — бот выбирает цель" and then went quiet forever, whether the shot
// hit, found nobody, or was refused by Twitch. A moderator watching chat for a ban that never
// came had no way to tell which.
//
// Channel-level rather than per-case on purpose: a shot is not tied to an appeal (see requestShot),
// so there is no case document to hang the answer off.
//
// The window keeps a page opened an hour later from toasting a shot from the previous shift; the
// bot resolves one within ~2s, so anything this old has already been seen.
async function findLatestResolved(channelId, windowMs) {
  const col = await ensureInitialized();
  return col.findOne(
    {
      channelId: String(channelId),
      status: { $in: ["done", "failed"] },
      resolvedAt: { $gte: new Date(Date.now() - windowMs) },
    },
    { sort: { resolvedAt: -1 } }
  );
}

// How many shots this moderator has fired in the last `windowMs`. The route uses it as a
// per-moderator ceiling: settingsWriteLimiter alone is too loose here, because unlike every other
// write on this site each one of these times a real person out of chat.
async function countRecentByUser(userId, windowMs) {
  const col = await ensureInitialized();
  return col.countDocuments({
    requestedById: String(userId),
    requestedAt: { $gte: new Date(Date.now() - windowMs) },
  });
}

module.exports = {
  requestShot,
  requestGrenade,
  grenadeReadyAt,
  countRecentByUser,
  findLatestResolved,
};
