// Builds the "dossier" shown next to an unban appeal on /:channel/unban-bureau: everything this
// site already knows about the banned user, so a moderator can judge the appeal without leaving
// the page.
//
// Read-only, across two bot-owned collections with INCOMPATIBLE channel conventions - `messages`
// stores `#login`, `ModeratorActionLogs` stores a bare `login`. Both go through statsRepo's
// withHash()/bareLogin() rather than re-deriving the rule here (that's how the two sides drift).
//
// The facts that AREN'T here - account creation date, follow date, avatar, Twitch's own moderator
// comments and its real ban/timeout/warning counts - live on the UnbanRequests document itself,
// put there by the bot, which is why getDossier() takes that document rather than a bare userId.
// None of them are fetchable from this app: the first three need Twitch scopes its OAuth app
// doesn't have, and the last two have no Helix endpoint at any scope (the bot reads them off
// Twitch's private GraphQL - see TwitchBot/twitch/gqlClient.js and ../CLAUDE.md's "Бюро амнистии").
const { connect } = require("./connection");
const { withHash, bareLogin, MOD_ACTION_CONTEXT_MAX_TTA_MS } = require("./statsRepo");
const { getKnownBotIdentifiers } = require("../lib/knownBotIds");
const profileCacheRepo = require("./profileCacheRepo");

const DEFAULT_LOG_LIMIT = 40;
// Below this many messages of our own, the log is served from Twitch's mirrored copy instead of
// ours - see getLogPage(). Ours is otherwise the better source (it pages without a ceiling, and it
// flags the message an action was probably for), but under a hundred lines that advantage is worth
// less than the years of history Twitch still holds for a user the bot only recently started
// seeing.
const THIN_LOG_MESSAGES = 100;
// How far apart a Twitch action row and one of our own ModeratorActionLogs rows may be and still
// be the same event. Ours is stamped when the bot's EventSub socket delivered it, Twitch's when it
// happened, so they differ by network latency - a second or two in practice.
const ACTION_MATCH_WINDOW_MS = 10 * 1000;
// Twitch's action type -> the vocabulary our own logs (and the rest of this page) use.
//
// The bot's own EventSub records only the first three plus `delete`, so the six below it can only
// ever arrive from Twitch's mirror - which is the point of them: a channel's 17 bans of which 16
// were LIFTED told the moderator nothing about the lifting until these were read (verified against
// the live #vlad_261 case).
const ACTION_TYPE_BY_TWITCH = {
  BAN: "ban",
  TIMEOUT: "timeout",
  WARN: "warn",
  UNBAN: "unban",
  UNTIMEOUT: "untimeout",
  ACKNOWLEDGE_WARNING: "warnAck",
  UNBAN_REQUEST_CREATED: "unbanRequest",
  UNBAN_REQUEST_APPROVED: "unbanApproved",
  UNBAN_REQUEST_DENIED: "unbanDenied",
};
// The two the applicant performs on themselves. Their mirrored row carries no moderator at all (see
// TwitchBot/twitch/viewerCardModLogs.js's `selfActed`), so the page has to name the applicant as the
// actor instead of resolving a null id through the profile cache.
const SELF_ACTED = new Set(["warnAck", "unbanRequest"]);
// Twitch count key -> the dossier's own. Only the first three have a local equivalent; the rest are
// simply absent when the mirror is (`countHumanActions` cannot know about them), which is why the
// page only ever renders them when they're above zero.
const COUNT_KEY_BY_TWITCH = {
  bans: "ban",
  timeouts: "timeout",
  warns: "warn",
  unbans: "unban",
  untimeouts: "untimeout",
  warnAcks: "warnAck",
  unbanRequests: "unbanRequest",
  unbanRequestsApproved: "unbanApproved",
  unbanRequestsDenied: "unbanDenied",
};

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = {
    messages: db.collection("messages"),
    modLogs: db.collection("ModeratorActionLogs"),
  };
  // Both reads below are served by indexes the bot already maintains (db/chatStats.js):
  // messages {channel, userId, timestamp} and ModeratorActionLogs {channel, userId, timestamp}.
  return collections;
}

// Per-action-type counts for this user in this channel, EXCLUDING actions taken by known bot
// accounts - a user auto-timed-out six times by the spam filter isn't the same as one a human
// moderator judged six times, and the dossier would be misleading if it conflated them.
async function countHumanActions(channelLogin, userId) {
  const { modLogs } = await ensureInitialized();
  const { ids, logins } = await getKnownBotIdentifiers();

  const rows = await modLogs
    .aggregate([
      {
        $match: {
          channel: bareLogin(channelLogin),
          userId: String(userId),
          // Both spellings: legacy rows hold a login string in modID rather than a numeric id.
          modID: { $nin: [...ids, ...logins] },
        },
      },
      { $group: { _id: "$action", count: { $sum: 1 } } },
    ])
    .toArray();

  const counts = { ban: 0, timeout: 0, delete: 0, warn: 0 };
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  return counts;
}

// The most recent ban - "Banned By" / "Banned at" in the dossier header. Deliberately NOT
// bot-filtered: if a bot issued the ban being appealed, that is exactly what the moderator needs
// to see. Note the bot never records `unban`/`untimeout` (twitch/events.js only logs
// ban/timeout/delete/warn), so this is "the last ban on record", not proof they're still banned -
// though for a case that came out of Twitch's own unban-request queue, they are.
async function findLastBan(channelLogin, userId) {
  const { modLogs } = await ensureInitialized();
  return modLogs.findOne(
    { channel: bareLogin(channelLogin), userId: String(userId), action: { $in: ["ban", "timeout"] } },
    { sort: { timestamp: -1 } }
  );
}

// One page of the merged activity log, oldest-first for display.
//
// Paged by MESSAGES (the bulk of the stream), then every moderation action falling inside that
// page's time range is interleaved - which is what makes the log read as a story ("...user says
// something, ftk789 bans them..."). Paging both streams independently would need a merge cursor
// for no real benefit: a user has orders of magnitude more messages than actions.
async function getLogPage(channelLogin, unbanCase, { before = null, limit = DEFAULT_LOG_LIMIT } = {}) {
  const { messages, modLogs } = await ensureInitialized();
  const userId = unbanCase.userId;
  const upperBound = before ? new Date(before) : new Date(8640000000000000);

  const mirrored = unbanCase?.twitchModLogs?.messages || [];
  const ownTotal = await messages.countDocuments({
    channel: withHash(channelLogin),
    userId: String(userId),
  });

  // Two different jobs for the same mirror, both wanted, each needing a different rule:
  //
  //   THIN (fewer than THIN_LOG_MESSAGES of our own) - Twitch's copy REPLACES ours outright. It is
  //   gap-free: the bot may have been offline for stretches, and a merge would silently skip
  //   whatever it missed in the middle.
  //
  //   DEEP (we have plenty, but the moderator pressed "load previous" past our oldest line) -
  //   Twitch's copy EXTENDS ours, strictly below the oldest message we hold. That boundary is what
  //   makes the join safe without de-duplication: the two sources share no message id, and
  //   matching on timestamp+text would eventually show a moderator the same line twice while they
  //   decide whether it justified a ban. Below our oldest, by definition, nothing can be a repeat.
  const useMirrorOnly = ownTotal < THIN_LOG_MESSAGES && mirrored.length > ownTotal;

  let ownDocs = [];
  if (!useMirrorOnly) {
    ownDocs = await messages
      .find({
        channel: withHash(channelLogin),
        userId: String(userId),
        timestamp: { $lt: upperBound },
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    ownDocs.reverse(); // chronological
  }

  // Where the mirror is allowed to start: below `before` when it is the only source, otherwise
  // below the oldest line we hold anywhere (not merely on this page).
  let mirrorCeiling = null;
  if (useMirrorOnly) {
    mirrorCeiling = upperBound;
  } else if (ownDocs.length < limit) {
    const oldestOwn = await messages.findOne(
      { channel: withHash(channelLogin), userId: String(userId) },
      { sort: { timestamp: 1 }, projection: { timestamp: 1 } }
    );
    // Our records ran out on this page; anything older than our very oldest is fair game. With no
    // records at all, `before` is the only bound there is.
    mirrorCeiling = oldestOwn ? oldestOwn.timestamp : upperBound;
    if (mirrorCeiling > upperBound) mirrorCeiling = upperBound;
  }

  const olderMirrored = mirrorCeiling
    ? mirrored
        .map((message) => ({
          _id: message.id,
          timestamp: new Date(message.timestamp),
          message: message.text,
          fromTwitch: true,
        }))
        .filter((doc) => doc.timestamp < mirrorCeiling)
        .sort((a, b) => b.timestamp - a.timestamp)
    : [];

  // The page is filled from the top up: Twitch's older lines first, then ours.
  const mirrorRoom = Math.max(0, limit - ownDocs.length);
  const mirrorPage = olderMirrored.slice(0, mirrorRoom).reverse();
  const mirrorRemaining = Math.max(0, olderMirrored.length - mirrorPage.length);
  const messageDocs = [...mirrorPage, ...ownDocs];

  // No messages left means we've reached the start of their history; actions older than any
  // surviving message would then have no window to fall into, so the log ends here.
  const lowerBound = messageDocs.length ? messageDocs[0].timestamp : null;
  const actionDocs = lowerBound
    ? await modLogs
        .find({
          channel: bareLogin(channelLogin),
          userId: String(userId),
          timestamp: { $gte: lowerBound, $lt: upperBound },
        })
        .sort({ timestamp: 1 })
        .toArray()
    : [];

  // Twitch's own mirrored actions falling in the same window - present whenever the bot never
  // witnessed the action itself (it was offline, or joined the channel after it happened), which
  // our own modLogs query above has no row for at all. Matched against actionDocs by the same
  // type+timestamp rule buildActionList uses, so an action both sides recorded doesn't show twice.
  const mirroredActions = lowerBound
    ? (unbanCase?.twitchModLogs?.actions || [])
        .map((row) => {
          const action = ACTION_TYPE_BY_TWITCH[row.type] || null;
          return {
            id: row.id,
            timestamp: new Date(row.timestamp),
            action,
            modId: row.modId,
            selfActed: Boolean(action && SELF_ACTED.has(action)),
            detail: row.detail || null,
          };
        })
        .filter((row) => row.action && row.timestamp >= lowerBound && row.timestamp < upperBound)
        .filter(
          (row) =>
            !actionDocs.some(
              (local) =>
                local.action === row.action &&
                Math.abs(local.timestamp.getTime() - row.timestamp.getTime()) <= ACTION_MATCH_WINDOW_MS
            )
        )
    : [];

  // A message is flagged as the probable reason for an action only when the bot recorded that
  // action within MOD_ACTION_CONTEXT_MAX_TTA_MS of it. `messageId` is a GUESS the bot makes at
  // action time (the user's latest message then), not Twitch ground truth - past that window it
  // is very likely unrelated, and presenting it as the cause would mislead the moderator judging
  // the appeal. Same rule statsRepo.getModActionContext applies.
  const flagged = new Set(
    actionDocs
      .filter((a) => a.messageId && a.TTA != null && a.TTA < MOD_ACTION_CONTEXT_MAX_TTA_MS)
      .map((a) => String(a.messageId))
  );

  const entries = [
    ...messageDocs.map((doc) => ({
      type: "message",
      id: String(doc._id),
      timestamp: doc.timestamp,
      text: doc.message,
      // Never set on a mirrored line: `probableCause` is the bot's own guess about its own
      // records, and Twitch's copy carries no equivalent.
      probableCause: !doc.fromTwitch && flagged.has(String(doc._id)),
      fromTwitch: Boolean(doc.fromTwitch),
    })),
    ...actionDocs.map((doc) => ({
      type: "action",
      id: String(doc._id),
      timestamp: doc.timestamp,
      action: doc.action,
      modId: String(doc.modID),
      reason: doc.reason || null,
      durationMs: doc.durationMs ?? null,
    })),
    ...mirroredActions.map((row) => ({
      type: "action",
      id: "twitch-" + row.id,
      timestamp: row.timestamp,
      action: row.action,
      modId: row.modId,
      selfActed: row.selfActed,
      reason: row.detail,
      durationMs: null,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  return {
    entries,
    // "Load previous" appears while EITHER source still has something older: our own records first,
    // then whatever of Twitch's snapshot this page didn't reach. It disappears only when both are
    // exhausted - which, for the mirror, means the 500-line ceiling the bot stored.
    // The client auto-loads the next page back when this is true and the moderator reaches the top
    // of the pane, so it is the only thing standing between them and an endless scroll.
    hasMore: ownDocs.length === limit || mirrorRemaining > 0,
    oldestTimestamp: lowerBound,
  };
}

// The "Mod comments" tab, straight off the case document.
//
// These are TWITCH's own moderator comments - the free-text notes moderators leave on a user in
// the viewer card - mirrored onto the UnbanRequests doc by the bot
// (TwitchBot/twitch/viewerCardModLogs.js). They are NOT derivable here: there is no Helix endpoint
// for them at any scope, and this app holds no Twitch moderation credentials at all.
//
// This tab used to show ban/timeout REASONS out of ModeratorActionLogs, which is a different thing
// wearing the same name - a reason explains one action, a comment is a note about the person. The
// reasons haven't gone anywhere; they still render inline against their action in the chat log.
//
// Returns [] when the bot never managed to fetch them (no token configured, expired session,
// Twitch outage) - indistinguishable from "no comments", which is the intended degradation.
function readMirroredComments(unbanCase) {
  const comments = unbanCase?.twitchModLogs?.comments;
  if (!Array.isArray(comments)) return [];
  return comments.map((comment) => ({
    id: String(comment.id),
    timestamp: comment.timestamp,
    text: comment.text || "",
    authorLogin: comment.authorLogin || null,
    authorDisplayName: comment.authorDisplayName || comment.authorLogin || null,
    authorColor: comment.authorColor || null,
    // A comment written in ANOTHER channel that shares its bans with this one. Labelled rather
    // than hidden: it's real evidence, but presenting it as this channel's own note would be a lie.
    shared: Boolean(comment.shared),
    sourceChannelLogin: comment.sourceChannelLogin || null,
  }));
}

// The punishments tab: every moderation action against this user, newest first, with each lifting
// folded onto the punishment it lifted rather than listed separately (see attachFollowUps).
//
// Twitch's list is the spine when we have it - it goes back to before the bot joined, and its
// label already carries the duration and the moderator's stated reason (there is no structured
// field for either; see TwitchBot/twitch/viewerCardModLogs.js). What OUR records add is the one
// thing Twitch has no notion of: `contextId`, the id of the matching ModeratorActionLogs row,
// which the page trades for the five messages the user sent before that action
// (/:channel/mod-action-context.json, already built for the mod-statistics page).
//
// Matching is by type + timestamp within ACTION_MATCH_WINDOW_MS, and only where the bot's own
// TTA rule says the context is meaningful - the same window statsRepo.getModActionContext enforces
// on the other side, applied here so the page never offers a hover that answers "not available".
async function buildActionList(channelLogin, unbanCase) {
  const { modLogs } = await ensureInitialized();
  const localRows = await modLogs
    .find({
      channel: bareLogin(channelLogin),
      userId: String(unbanCase.userId),
      action: { $in: ["ban", "timeout", "warn"] },
    })
    .sort({ timestamp: -1 })
    .toArray();

  const twitchRows = unbanCase?.twitchModLogs?.actions || [];

  // No Twitch mirror (no token, expired session, outage): our own rows become the list, rendered
  // from the same fields so the tab looks identical, just shorter.
  if (!twitchRows.length) {
    return localRows.map((row) => ({
      id: String(row._id),
      timestamp: row.timestamp,
      action: row.action,
      modId: String(row.modID),
      modDisplayName: null, // resolved through the profile cache with the rest of the dossier
      selfActed: false, // our own records only hold the four types a moderator performs
      detail: row.reason || null,
      durationMs: row.durationMs ?? null,
      contextId: hasUsableContext(row) ? String(row._id) : null,
      source: "bot",
    }));
  }

  const unmatched = [...localRows];
  const rows = twitchRows.map((row) => {
    const action = ACTION_TYPE_BY_TWITCH[row.type] || null;
    const timestamp = new Date(row.timestamp);
    const index = unmatched.findIndex(
      (local) =>
        local.action === action &&
        Math.abs(local.timestamp.getTime() - timestamp.getTime()) <= ACTION_MATCH_WINDOW_MS
    );
    // Consumed so two actions of the same type seconds apart can't both claim one local row.
    const local = index === -1 ? null : unmatched.splice(index, 1)[0];

    return {
      id: row.id,
      timestamp,
      action,
      modId: row.modId,
      // Twitch ships the moderator's display name with the row, so unlike our own rows this needs
      // no profile lookup.
      modDisplayName: row.modDisplayName || row.modLogin || null,
      selfActed: Boolean(action && SELF_ACTED.has(action)),
      detail: row.detail || null,
      durationMs: local?.durationMs ?? null,
      contextId: local && hasUsableContext(local) ? String(local._id) : null,
      source: "twitch",
    };
  });

  return attachFollowUps(rows);
}

// What happened to each punishment AFTERWARDS, folded onto the punishment's own row.
//
// A lifting is only meaningful next to the thing it lifted: "timeout 2 weeks" followed three rows
// later by a bare "timeout lifted" makes the reader pair them by eye, and on this user's history
// (49 timeouts, 16 liftings, often minutes apart) that is not a pairing anyone does reliably. Folded
// in, the row says the one thing an amnesty decision turns on - how long the punishment ACTUALLY
// stood, as opposed to how long it was issued for.
const FOLLOW_UP_TARGET = { unban: "ban", untimeout: "timeout", warnAck: "warn" };

function attachFollowUps(rows) {
  // Oldest first: a lifting closes the punishment that was open when it happened, so the list has to
  // be walked forwards even though it is rendered backwards.
  const chronological = [...rows].reverse();
  // The punishment of each kind that is currently in force and not yet closed.
  const open = new Map();
  const consumed = new Set();

  for (const row of chronological) {
    const target = FOLLOW_UP_TARGET[row.action];
    if (!target) {
      // A fresh punishment supersedes any earlier one of its kind that was never lifted - it simply
      // expired on its own, and its row correctly shows no follow-up.
      if (row.action) open.set(row.action, row);
      continue;
    }
    const punishment = open.get(target);
    // A lifting with nothing open belongs to a punishment older than the rows Twitch returned
    // (MAX_ACTION_ROWS is per type), so it stays a row of its own rather than being dropped.
    if (!punishment) continue;
    punishment.followUp = {
      id: row.id,
      action: row.action,
      timestamp: row.timestamp,
      modId: row.modId,
      modDisplayName: row.modDisplayName,
      selfActed: row.selfActed,
      // How long it actually stood. Compared against the row's own issued duration by the reader,
      // which is the whole point: a two-week timeout lifted after a minute is a different fact.
      afterMs: row.timestamp && punishment.timestamp
        ? row.timestamp.getTime() - punishment.timestamp.getTime()
        : null,
    };
    consumed.add(row.id);
    open.delete(target);
  }

  return rows.filter((row) => !consumed.has(row.id));
}

// Whether the five-messages-before popup would have anything to show for one of our rows. The
// `messageId` the bot records is a GUESS (the user's latest message at action time), trusted only
// inside the TTA window - the same rule getLogPage's `probableCause` flag applies.
function hasUsableContext(row) {
  return Boolean(row.messageId) && row.TTA != null && row.TTA < MOD_ACTION_CONTEXT_MAX_TTA_MS;
}

// Turns the numeric modIDs scattered through a dossier into display names + chat colors in one
// batch. Legacy login-string modIDs are passed through unchanged (getOrFetchProfiles already
// filters to numeric ids, so they simply miss the cache and fall back to themselves).
async function resolveModeratorNames(modIds) {
  const unique = [...new Set(modIds.map(String).filter(Boolean))];
  const [profiles, bots] = await Promise.all([
    profileCacheRepo.getOrFetchProfiles(unique),
    getKnownBotIdentifiers(),
  ]);
  const botSet = new Set([...bots.ids, ...bots.logins]);
  const resolved = {};
  for (const id of unique) {
    const profile = profiles.get(id);
    resolved[id] = {
      displayName: profile?.displayName || id,
      color: profile?.chatColor || null,
      // Lets the page mark a bot-issued action. Needed because the ban/timeout COUNTS exclude bots
      // while `lastBan` deliberately doesn't (if a bot issued the ban being appealed, that's the
      // first thing the moderator needs to see) - without this mark, "Banned by: chatwizardbot"
      // sitting above "Bans: 0" reads as a bug rather than as the two different questions they are.
      isBot: botSet.has(id) || botSet.has((profile?.login || "").toLowerCase()),
    };
  }
  return resolved;
}

// The whole dossier for one case, in one call.
//
// Takes the UnbanRequests document rather than a bare userId because half the dossier now lives on
// it: the moderator comments and Twitch's own action counts, both mirrored there by the bot.
async function getDossier(channelLogin, unbanCase, { before = null, limit = DEFAULT_LOG_LIMIT } = {}) {
  const userId = unbanCase.userId;
  // Twitch's counts are this channel's REAL lifetime totals; ours only cover what the bot
  // witnessed since it joined, which for an old account is a small fraction (a user Twitch counts
  // at 17 bans had 0 on record here). So the local aggregation is a fallback, not the default -
  // and it isn't even run when the mirrored numbers are there.
  const twitchCounts = unbanCase?.twitchModLogs?.counts || null;
  const [localCounts, lastBan, log, actions] = await Promise.all([
    twitchCounts ? null : countHumanActions(channelLogin, userId),
    findLastBan(channelLogin, userId),
    getLogPage(channelLogin, unbanCase, { before, limit }),
    buildActionList(channelLogin, unbanCase),
  ]);

  let counts;
  if (twitchCounts) {
    counts = {
      // A history longer than the page the bot asked Twitch for - the page renders "1000+"
      // rather than a number it can't stand behind.
      truncated: Boolean(twitchCounts.truncated),
      source: "twitch",
    };
    for (const [twitchKey, ourKey] of Object.entries(COUNT_KEY_BY_TWITCH)) {
      counts[ourKey] = twitchCounts[twitchKey] || 0;
    }
  } else {
    counts = { ...localCounts, truncated: false, source: "bot" };
  }

  const modComments = readMirroredComments(unbanCase);
  const activeStrike = unbanCase?.twitchModLogs?.activeStrike || null;

  // Comment authors carry their own display name and chat colour from Twitch, so only the log's
  // and the last ban's moderator ids need resolving through the profile cache.
  const moderators = await resolveModeratorNames([
    ...(lastBan ? [lastBan.modID] : []),
    ...(activeStrike?.modId ? [activeStrike.modId] : []),
    ...log.entries.filter((e) => e.type === "action").map((e) => e.modId),
    // Twitch-sourced rows already carry a display name, but their modId still resolves the chat
    // colour and the bot mark; a row from our own records has nothing but the id.
    ...actions.map((a) => a.modId).filter(Boolean),
    // Whoever lifted a punishment is often not whoever issued it - that contrast is half of why the
    // lifting is shown at all, so their id needs resolving too.
    ...actions.map((a) => a.followUp?.modId).filter(Boolean),
  ]);

  return {
    counts,
    actions,
    // The restriction IN FORCE, which is what the card's "banned by / banned at" is asking about.
    // Twitch's answer wins outright when we have it: ours is the last ban the bot happened to
    // WITNESS, and on the test case that was a different moderator on a different date than the
    // ban actually being appealed.
    lastBan: activeStrike
      ? {
          action: activeStrike.kind,
          timestamp: activeStrike.at,
          modId: activeStrike.modId,
          modDisplayName: activeStrike.modDisplayName,
          reason: activeStrike.reason,
          durationMs: null,
          source: "twitch",
        }
      : lastBan
      ? {
          action: lastBan.action,
          timestamp: lastBan.timestamp,
          modId: String(lastBan.modID),
          modDisplayName: null,
          reason: lastBan.reason || null,
          durationMs: lastBan.durationMs ?? null,
          source: "bot",
        }
      : null,
    // Twitch's own risk read: ban-evasion AND harassment likelihoods, enforcement treatment, and any
    // ban-sharing channels that also have this user banned. Null when the mirror is absent.
    risk: unbanCase?.twitchModLogs?.risk || null,
    // Whether this CHANNEL participates in Twitch's ban sharing, which is what says whether `risk`'s
    // empty `sharedBanChannels` and the comments tab's missing shared notes mean "nothing to find" or
    // "we were never allowed to look". Same shape of trap as `subscription`'s three states.
    banSharing: unbanCase?.twitchModLogs?.banSharing || null,
    log,
    modComments,
    // {state: 'subscribed'|'none'|'unavailable', tier, prime}, or null when the bot never got a
    // viewer card - the page keeps saying "unknown" in that case rather than guessing "not
    // subscribed". See TwitchBot/twitch/viewerCardModLogs.js for why this isn't a boolean.
    subscription: unbanCase?.twitchModLogs?.subscription || null,
    moderators,
  };
}

module.exports = {
  DEFAULT_LOG_LIMIT,
  getDossier,
  getLogPage,
};
