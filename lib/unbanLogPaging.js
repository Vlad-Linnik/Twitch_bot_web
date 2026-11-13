// The Unban Bureau's chat log: which source a page is drawn from, how the two sources join, and
// how a page boundary is placed so that walking the log in either direction neither repeats a line
// nor skips one. Pure - db/unbanDossierRepo.js's getLogPage() does the Mongo reads and hands the
// candidates to these functions, which is what lets the paging rules be tested without a database.
//
// Two sources, never interleaved line by line:
//
//   ours   - `messages`, written by the bot. Unbounded, but only since the bot joined the channel,
//            and with holes wherever the bot was offline.
//   mirror - `UnbanRequests.twitchModLogs.messages`, Twitch's own copy (viewerCardModLogs), read by
//            the bot on demand. Gap-free and years deep, but capped at the 500 lines the bot asks
//            for, and it shares no message id with ours.
//
// Because the two share no id, a line present in both can only be matched on timestamp + text,
// and that match is a guess. So they are never merged within one stretch of time: a THIN log (fewer
// than THIN_LOG_MESSAGES of ours, and a longer mirror) is served from the mirror ALONE; otherwise
// ours is served and the mirror only EXTENDS it strictly below the oldest line we hold. Either way
// every moment of the log has exactly one source, which is what makes a repeat impossible by
// construction rather than by a de-duplication pass that might match too much or too little.
//
// Paging. A page is a half-open interval of time [lo, hi) - `hi` null means "open to the present".
// The messages decide where the edges go; moderation actions are then attached to whichever page's
// interval they fall into. Adjacent pages share an edge exactly (one page's `lo` is the next older
// page's `hi`), so every action lands on one page and one only. The cursors handed to the browser
// ARE those edges: `before=<lo>` asks for the page that ends where this one starts, `after=<hi>` for
// the one that starts where this one ends.
//
// Ties. Several lines with the same millisecond are rare but real (the mirror's timestamps are
// Twitch's, ours are the bot's clock), and a limit that falls in the middle of such a group would
// otherwise put an edge through it: half the group on this page, the other half skipped by the next
// page's strict comparison. cutPage() therefore never splits a group - it leaves the whole group to
// the next page.

// Below this many messages of our own, the log is served from Twitch's mirrored copy instead of
// ours. Ours is otherwise the better source (it pages without a ceiling, and it flags the message
// an action was probably for), but under a hundred lines that advantage is worth less than the
// years of history Twitch still holds for a user the bot only recently started seeing.
const THIN_LOG_MESSAGES = 100;

// How far apart a Twitch action row and one of our own ModeratorActionLogs rows may be and still
// be the same event. Ours is stamped when the bot's EventSub socket delivered it, Twitch's when it
// happened, so they differ by network latency - a second or two in practice.
const ACTION_MATCH_WINDOW_MS = 10 * 1000;

// Twitch's action type -> the vocabulary our own logs (and the rest of the page) use.
//
// The bot's own EventSub records only the first three plus `delete`, so the six below it can only
// ever arrive from Twitch's mirror - which is the point of them: a channel's 17 bans of which 16
// were LIFTED told the moderator nothing about the lifting until these were read.
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

const OLDER = "older";
const NEWER = "newer";
const LATEST = "latest";

function toValidDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads the paging request. `before` walks to older lines, `after` to newer ones, neither means the
 * newest page. Both at once is refused rather than guessed at: there is no single page that answers
 * it.
 */
function parseLogCursor({ before = null, after = null } = {}) {
  const hasBefore = before != null && before !== "";
  const hasAfter = after != null && after !== "";
  if (hasBefore && hasAfter) return { ok: false, error: "both_cursors" };
  if (hasBefore) {
    const at = toValidDate(before);
    return at ? { ok: true, direction: OLDER, at } : { ok: false, error: "bad_cursor" };
  }
  if (hasAfter) {
    const at = toValidDate(after);
    return at ? { ok: true, direction: NEWER, at } : { ok: false, error: "bad_cursor" };
  }
  return { ok: true, direction: LATEST, at: null };
}

/** "mirror" = Twitch's copy replaces ours outright; "own" = ours, extended below by the mirror. */
function chooseLogSource({ ownTotal, mirroredCount }) {
  return ownTotal < THIN_LOG_MESSAGES && mirroredCount > ownTotal ? "mirror" : "own";
}

function compareAsc(a, b) {
  const diff = a.timestamp.getTime() - b.timestamp.getTime();
  if (diff) return diff;
  const ka = docKey(a);
  const kb = docKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Distinct across the two sources even if an id string happened to coincide.
function docKey(doc) {
  return (doc.fromTwitch ? "t:" : "o:") + String(doc._id);
}

/**
 * The mirror's stored lines in the shape `messages` documents have, oldest first. Repeated ids are
 * dropped (Twitch has never sent one, but a page that renders the same id twice is exactly the
 * defect this module exists to rule out), and so is a line whose timestamp does not parse - it has
 * no place in a time-ordered log.
 */
function normalizeMirrorMessages(mirrored) {
  const seen = new Set();
  const out = [];
  for (const message of mirrored || []) {
    if (!message) continue;
    const timestamp = toValidDate(message.timestamp);
    if (!timestamp) continue;
    const id = message.id != null && message.id !== "" ? String(message.id) : null;
    const key = id || `${timestamp.getTime()}|${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ _id: key, timestamp, message: message.text, fromTwitch: true });
  }
  return out.sort(compareAsc);
}

/**
 * Up to `limit + 1` mirror lines for one page, in walking order (newest first for older/latest,
 * oldest first for newer). `ceiling` is the exclusive upper bound of the stretch the mirror is
 * allowed to cover - our oldest line when ours is the source, null when the mirror stands alone.
 * The one extra line is what tells cutPage() whether anything lies beyond the page.
 */
function mirrorCandidates(mirrorAsc, { direction, at = null, ceiling = null, limit }) {
  const rows = mirrorAsc.filter((doc) => {
    if (ceiling && !(doc.timestamp < ceiling)) return false;
    if (direction === OLDER) return doc.timestamp < at;
    if (direction === NEWER) return doc.timestamp >= at;
    return true;
  });
  if (direction === NEWER) return rows.slice(0, limit + 1);
  return rows.slice(-(limit + 1)).reverse();
}

/**
 * Joins candidate lists into one walking-order sequence: newest first for older/latest, oldest
 * first for newer. A document appearing twice (same source, same id) is kept once.
 */
function mergeWalk(direction, ...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const doc of list || []) {
      const key = docKey(doc);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(doc);
    }
  }
  merged.sort(compareAsc);
  if (direction !== NEWER) merged.reverse();
  return merged;
}

/**
 * Takes one page off the front of a walk.
 *
 * Returns the page's messages oldest-first, whether more lie beyond it (`more`), and - when they
 * do - `boundary`, the timestamp of the first line NOT taken. A group of lines sharing the boundary
 * millisecond is left whole for the next page; only if that group alone is longer than a page is it
 * taken whole here instead, since a page that takes nothing would never move the cursor.
 */
function cutPage(walk, limit, direction) {
  if (walk.length <= limit) {
    const docs = walk.slice();
    if (direction !== NEWER) docs.reverse();
    return { docs, more: false, boundary: null };
  }
  const boundary = walk[limit].timestamp;
  let taken = walk.slice(0, limit).filter((doc) => doc.timestamp.getTime() !== boundary.getTime());
  if (!taken.length) taken = walk.filter((doc) => doc.timestamp.getTime() === boundary.getTime());
  if (direction !== NEWER) taken.reverse();
  return { docs: taken, more: true, boundary };
}

/**
 * The page's interval [lo, hi) and the two cursors leading out of it.
 *
 * The oldest page ends at its oldest message rather than at the beginning of time: an action older
 * than any surviving line has nothing to be read against, and the mirror is capped, so "older than
 * every line" usually means "older than the 500th line back", not "before they ever spoke".
 */
function pageWindow({ direction, at = null, docs, more, boundary }) {
  const oldest = docs.length ? docs[0].timestamp : null;
  let lo;
  let hi;
  let hasOlder;
  let hasNewer;
  if (direction === NEWER) {
    lo = at;
    hi = more ? boundary : null;
    hasOlder = true;
    hasNewer = more;
  } else {
    lo = oldest;
    hi = direction === OLDER ? at : null;
    hasOlder = more;
    hasNewer = direction === OLDER;
  }
  return {
    lo,
    hi,
    hasOlder: Boolean(hasOlder && lo),
    olderCursor: hasOlder && lo ? lo : null,
    hasNewer: Boolean(hasNewer && hi),
    newerCursor: hasNewer && hi ? hi : null,
  };
}

function inWindow(timestamp, { lo, hi }) {
  if (!lo) return false;
  return timestamp >= lo && (!hi || timestamp < hi);
}

// Which UNBAN_REQUEST_CREATED rows in the Twitch mirror were actually decided (a later
// UNBAN_REQUEST_APPROVED/DENIED for the same user). The request THIS case is reviewing is, by
// definition, undecided - nobody has ruled on it yet - so this rule alone is what keeps it out of
// the log: its text already sits on the desk as the case itself, and every case would otherwise end
// its log with the same non-fact ("filed an appeal"). An older CREATED row that never got a verdict
// (expired, or the applicant left before it was reviewed) is dropped for the same reason.
function resolvedAppealIds(twitchRows) {
  const chronological = [...(twitchRows || [])]
    .filter((row) => row.type === "UNBAN_REQUEST_CREATED" || row.type === "UNBAN_REQUEST_APPROVED" || row.type === "UNBAN_REQUEST_DENIED")
    .map((row) => ({ id: row.id, type: row.type, timestamp: new Date(row.timestamp) }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const resolved = new Set();
  let openId = null;
  for (const row of chronological) {
    if (row.type === "UNBAN_REQUEST_CREATED") {
      openId = row.id;
    } else if (openId) {
      resolved.add(openId);
      openId = null;
    }
  }
  return resolved;
}

/**
 * Twitch's mirrored actions that belong on this page: inside its interval, of a kind the page
 * knows, a past appeal only once it has a verdict, and not already present as one of our own
 * rows. Ours is matched by type within ACTION_MATCH_WINDOW_MS - the two clocks differ by network
 * latency - so an action both sides recorded shows once.
 */
function mirroredActionsInWindow(twitchRows, window, localActions) {
  const resolvedAppeals = resolvedAppealIds(twitchRows);
  return (twitchRows || [])
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
    .filter((row) => row.action && !Number.isNaN(row.timestamp.getTime()) && inWindow(row.timestamp, window))
    .filter((row) => row.action !== "unbanRequest" || resolvedAppeals.has(row.id))
    .filter(
      (row) =>
        !(localActions || []).some(
          (local) =>
            local.action === row.action &&
            Math.abs(new Date(local.timestamp).getTime() - row.timestamp.getTime()) <= ACTION_MATCH_WINDOW_MS
        )
    );
}

/**
 * The page's rows, oldest first. Messages sort ahead of an action stamped the same millisecond (the
 * line a moderator acted on reads before the action), and any repeated `type:id` is dropped - a
 * cheap last guard on top of the rules above, never the thing they rely on.
 */
function assembleLogEntries({ messageDocs = [], actionDocs = [], mirroredActions = [], flaggedIds = new Set() }) {
  const entries = [
    ...messageDocs.map((doc) => ({
      type: "message",
      id: String(doc._id),
      timestamp: doc.timestamp,
      text: doc.message,
      // Never set on a mirrored line: `probableCause` is the bot's own guess about its own
      // records, and Twitch's copy carries no equivalent.
      probableCause: !doc.fromTwitch && flaggedIds.has(String(doc._id)),
      fromTwitch: Boolean(doc.fromTwitch),
      // The partner channel this line was written in during a Twitch shared-chat session (a
      // numeric channel id). Null covers three things that cannot be told apart: sent in this
      // channel, sent before the bot recorded the tag, or mirrored from Twitch - whose copy carries
      // no source-channel field at all. So it marks what IS foreign and never claims the rest is ours.
      sourceChannelId: !doc.fromTwitch && doc.sourceRoomId ? String(doc.sourceRoomId) : null,
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
  ];

  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = entry.type + ":" + entry.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = (entry) => (entry.type === "message" ? 0 : 1);
  return unique.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() || rank(a) - rank(b)
  );
}

module.exports = {
  THIN_LOG_MESSAGES,
  ACTION_MATCH_WINDOW_MS,
  ACTION_TYPE_BY_TWITCH,
  SELF_ACTED,
  OLDER,
  NEWER,
  LATEST,
  parseLogCursor,
  chooseLogSource,
  normalizeMirrorMessages,
  mirrorCandidates,
  mergeWalk,
  cutPage,
  pageWindow,
  inWindow,
  resolvedAppealIds,
  mirroredActionsInWindow,
  assembleLogEntries,
};
