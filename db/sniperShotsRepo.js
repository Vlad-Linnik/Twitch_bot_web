// `SniperShots` — the "stray bullet" fired from the Бюро амнистии review desk's rifle scope.
//
// OWNERSHIP: TwitchBot/db/sniperShotsRepo.js is the origin of this document shape.
//
// This app can only ever write a `pending` REQUEST. It never picks the target: that happens
// bot-side (TwitchBot/twitch/unbanRequestScheduler.js's fireSniper), against the live chatter list,
// with the broadcaster/moderators/known bots filtered out. Keeping the choice server-side is what
// stops this endpoint from being a way to time out a named person on demand — the page can ask for
// "someone", never for "them". Same execute-only-by-bot contract as LongBans and UnbanRequests; see
// ../CLAUDE.md's "Бюро амнистии" section.
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
async function requestShot(channel, user, caseId) {
  const col = await ensureInitialized();
  const doc = {
    channelId: String(channel.channelId),
    channelLogin: channel.channelLogin,
    caseId: caseId || null,
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

module.exports = { requestShot, countRecentByUser };
