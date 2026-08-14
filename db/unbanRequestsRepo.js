// Reads + decision/vote requests for the `UnbanRequests` collection, backing /:channel/unban-bureau.
//
// OWNERSHIP: TwitchBot/db/unbanRequestsRepo.js is the origin of this document shape - the bot
// mirrors Twitch's unban-request queue into it and enriches each doc with the two dossier facts
// only its token can read (account creation date, follow date).
//
// Like LongBans and unlike custom_commands/counters, this app can NEVER execute either side
// itself: approving or denying needs moderator:manage:unban_requests on a user token, and this
// app's Twitch app has no moderation scopes at all (twitch/oauthClient.js requests only
// moderation:read). So this module writes exactly two things - `resolution.status: 'pending'`
// (a moderator pressed Approve/Deny) and `vote.status: 'requested'` (asking chat to weigh in) -
// and TwitchBot/twitch/unbanRequestScheduler.js does the rest within its next ~60s poll.
// See ../CLAUDE.md's "Unban requests: written by both repos, executed only by the bot".
const { ObjectId } = require("mongodb");
const { connect } = require("./connection");

const MAX_RESOLUTION_TEXT = 500; // Twitch's own cap, mirrored from TwitchBot/twitch/unbanRequestsAPI.js

let collection;

// See requestDecision() below for why this exists rather than reading `.value` directly.
function unwrap(result) {
  return result && result.value !== undefined ? result.value : result;
}

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("UnbanRequests");
  // The review queue. The bot maintains the same index (its own repo creates it too) - declared
  // here as well so a fresh web deploy against an empty collection isn't waiting on the bot.
  await collection.createIndex({ channelId: 1, twitchStatus: 1, requestedAt: -1 });
  return collection;
}

// The cases awaiting review. `newestFirst` backs the page's sort toggle.
// Every case is serialized into the page's `data-cases` attribute, so `twitchModLogs` is projected
// OUT: the mirror (comments, punishment rows, hundreds of chat lines) is the biggest thing on the
// document and none of it is needed until a case is opened, at which point dossier.json fetches it
// per case. Keeping it here grew one channel's markup from 1KB to 25KB with a single case on the
// queue, and it scales with the length of every applicant's history.
async function listPendingForChannel(channelId, { newestFirst = true } = {}) {
  const col = await ensureInitialized();
  return col
    .find(
      {
        channelId: String(channelId),
        twitchStatus: "pending",
        // A case a moderator already stamped stays twitchStatus: "pending" at Twitch until the
        // bot's next tick actually PATCHes it (routes/unbanBureau.js's decide.json only records
        // the decision) - for an immediate decision that's under a minute, but an approval with a
        // future "решение вступает в силу" date can sit here for weeks, and without this it would
        // reappear in the queue on every page load until the bot gets to it.
        "resolution.status": { $ne: "pending" },
      },
      { projection: { twitchModLogs: 0 } }
    )
    .sort({ requestedAt: newestFirst ? -1 : 1 })
    .toArray();
}

// Approved appeals sitting on a future "решение вступает в силу" date. listPendingForChannel()
// deliberately excludes these (see its own comment) once a moderator stamps the decision, so
// without this there is nowhere on the site to see that one is scheduled - routes/longBans.js
// surfaces it on the Long Bans page since that's the other place a channel tracks a pending
// change to someone's chat access.
async function listScheduledAmnestyForChannel(channelId) {
  const col = await ensureInitialized();
  return col
    .find(
      {
        channelId: String(channelId),
        "resolution.status": "pending",
        "resolution.decision": "approved",
        "resolution.effectiveAt": { $ne: null },
      },
      { projection: { twitchModLogs: 0 } }
    )
    .sort({ "resolution.effectiveAt": 1 })
    .toArray();
}

async function findById(id) {
  if (!ObjectId.isValid(id)) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id: new ObjectId(id) });
}

// Records a moderator's decision for the bot to apply. Deliberately refuses to overwrite a
// decision that's already queued or applied: the page is a fast keyboard-driven UI, so a
// double-tap of A/D (or two moderators on the same case at once) is expected, not exceptional.
// Returns the updated doc, or null if the case was already decided / not in this channel.
async function requestDecision(id, channelId, { decision, text, user, effectiveAt = null }) {
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    {
      _id: new ObjectId(id),
      channelId: String(channelId),
      twitchStatus: "pending",
      // null (never decided) or 'failed' (the bot tried and Twitch refused - retrying is fine).
      $or: [{ "resolution.status": null }, { "resolution.status": "failed" }],
    },
    {
      $set: {
        "resolution.status": "pending",
        "resolution.decision": decision,
        "resolution.text": text ? text.slice(0, MAX_RESOLUTION_TEXT) : null,
        // "решение вступает в силу" - when the bot should actually PATCH Twitch. null means
        // immediately (TwitchBot/twitch/unbanRequestScheduler.js's findResolutionPending() applies
        // it on its very next tick); routes/unbanBureau.js's decide.json only ever passes a future
        // date through here, and only for an 'approved' decision.
        "resolution.effectiveAt": effectiveAt || null,
        "resolution.decidedById": String(user.userId),
        "resolution.decidedByLogin": user.login,
        "resolution.decidedByDisplayName": user.displayName,
        "resolution.decidedAt": new Date(),
        "resolution.appliedAt": null,
        "resolution.failureReason": null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  // Driver-version-safe unwrap, same idiom as db/gameRunsRepo.js's consumeRun(): mongodb@6 hands
  // back the document itself (or null on no match), older drivers wrap it in `{ value }`. Reading
  // `result.value` unguarded - as this file did originally - throws on the no-match path, which is
  // exactly the already-decided race the caller relies on turning into a 409.
  return unwrap(result);
}

// Asks the bot to run a chat vote on this case. Same "don't clobber" guard: a vote already
// requested or running must not be restarted (that would reset the tally mid-vote).
async function requestVote(id, channelId) {
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    {
      _id: new ObjectId(id),
      channelId: String(channelId),
      twitchStatus: "pending",
      // 'closeRequested' counts as done for this purpose: the moderator has already moved on, and
      // making them wait for the bot's next 2s tick before the new case could open its vote would
      // show an empty vote bar on a case chat is about to be asked about anyway.
      $or: [
        { "vote.status": null },
        { "vote.status": "closed" },
        { "vote.status": "closeRequested" },
      ],
    },
    {
      $set: {
        "vote.status": "requested",
        "vote.startedAt": null,
        "vote.endsAt": null,
        "vote.approve": 0,
        "vote.deny": 0,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  return unwrap(result);
}

// Asks the bot to close the vote on this appeal, because a verdict was just stamped on it. This
// app can't close one itself: closing announces the tally in chat, which needs the bot's IRC
// connection. Only a vote that is actually live is touched, so a verdict on an appeal chat never
// voted on is a no-op rather than an error.
async function requestVoteClose(id, channelId) {
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    {
      _id: new ObjectId(id),
      channelId: String(channelId),
      "vote.status": { $in: ["requested", "active"] },
    },
    { $set: { "vote.status": "closeRequested", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return unwrap(result);
}

// Asks the bot to fetch this case's Twitch viewer card - the moderator comments, the real lifetime
// counts, the risk read and the channel's chat rules. Same "the site asks, the bot executes"
// contract as requestDecision/requestVote above, and for the same reason: those facts come from
// Twitch's private GraphQL, which needs a full browser-session token this app deliberately does not
// hold (see ../CLAUDE.md's "Бюро амнистии").
//
// Called when a moderator OPENS a case, which since 2026-08-15 is the only thing that causes the
// bot to read that endpoint at all. It used to mirror the whole pending queue on a 30-minute timer
// whether anyone looked or not - an appeal nobody reached in three days cost ~144 requests to an
// undocumented, rate-limited endpoint where one would have done.
//
// Unconditional on purpose: this app does not know the freshness TTL (it lives in the bot, next to
// the fetch), so it flags every first dossier load and lets the bot decide. Reopening a case inside
// the window costs one tiny $set here and no Twitch call at all. Fire-and-forget - a failure here
// must never fail the dossier the moderator asked for, which renders fine from our own records.
async function requestViewerCard(id, channelId) {
  const col = await ensureInitialized();
  await col.updateOne(
    { _id: new ObjectId(id), channelId: String(channelId) },
    { $set: { viewerCardRequestedAt: new Date() } }
  );
}

// Just the volatile bits, for the page's live vote bar / decision-applied polling. Projected down
// so a 2s poll doesn't drag the whole appeal text and enrichment along every time.
//
// The sniper shot deliberately does NOT come from here. It used to (`sniper: 1` in the projection
// below), from a `sniper` sub-document written back when a shot fired automatically as a vote
// closed and was therefore 1:1 with a case. The bot stopped writing it when the shot became a
// manual act with its own `SniperShots` collection, and this kept projecting a field that no
// longer moves - so the desk never announced an outcome at all. The route reads
// db/sniperShotsRepo.js's findLatestResolved() alongside this instead: channel-level, because a
// shot is not tied to an appeal.
async function getLiveState(channelId, ids) {
  const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!objectIds.length) return [];
  const col = await ensureInitialized();
  return col
    .find(
      { _id: { $in: objectIds }, channelId: String(channelId) },
      { projection: { vote: 1, resolution: 1, twitchStatus: 1 } }
    )
    .toArray();
}

module.exports = {
  MAX_RESOLUTION_TEXT,
  listPendingForChannel,
  listScheduledAmnestyForChannel,
  findById,
  requestDecision,
  requestVote,
  requestVoteClose,
  requestViewerCard,
  getLiveState,
};
