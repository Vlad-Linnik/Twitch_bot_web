// Moderator-only chat log search: the per-user log panel on /<channel>/user/<name> and the
// Universal Log Search on /<channel>. Both are gated at the route with requireLevel(2).
//
// WHY THERE IS NO $text INDEX, AND NO SEMANTIC SEARCH
// ---------------------------------------------------
// The tempting designs both lose on a 2GB VPS:
//
//   $text index on messages.message  - a full-text index across ~1.9M message bodies is a large
//                                      structure MongoDB wants resident; it would compete with
//                                      the indexes that make every OTHER page on this site fast,
//                                      and it still cannot do substring or typo matching.
//   embeddings / vector search       - the model alone is 100-500MB resident and the vectors run
//                                      ~1.5KB per message (multiple GB at this corpus size).
//                                      Not viable in 2GB. Not attempted.
//
// What actually works is MANDATORY NARROWING. A search is never allowed to be "find this string
// in the whole collection". Channel is always required and a time window is always applied, so
// the {channel, userId, timestamp} index reduces the candidate set BEFORE any text matching
// happens; the regex then runs over a bounded slice. Adding users to the filter narrows it
// further, so the multi-user search is CHEAPER than the channel-wide one, not more expensive.
//
// Fuzzy matching is offered on the same principle: it is allowed only once the candidate set is
// small enough to scan in Node, and is otherwise refused with a reason the UI can show, rather
// than silently melting the box.
const { connect } = require("./connection");
const limits = require("../config/statsLimits");

let collections;

async function ensureInitialized() {
  if (collections) return collections;
  const db = await connect();
  collections = { messages: db.collection("messages") };
  return collections;
}

const withHash = (channelLogin) => `#${channelLogin.toLowerCase().replace(/^#/, "")}`;

// A user-supplied search term goes into a RegExp, so every regex metacharacter must be inert -
// otherwise a term like "a{99999}" or "(a+)+$" is a denial-of-service against the box we are
// trying to protect.
function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Levenshtein with early exit: the moment the best possible remaining distance exceeds maxDist
// we stop, so this is O(len * maxDist) rather than O(len^2). Only ever called on single tokens
// (<= 30 chars) from an already-narrowed candidate set.
function withinEditDistance(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  if (a === b) return true;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowBest) rowBest = curr[j];
    }
    if (rowBest > maxDist) return false; // whole row already too far - no later row can recover
    prev = curr;
  }
  return prev[b.length] <= maxDist;
}

// Typo tolerance scaled to word length: "hi" should not fuzzy-match "ho", but a 9-letter word
// surviving one transposition is a genuine typo.
function allowedEdits(term) {
  if (term.length <= 4) return 0;
  if (term.length <= 7) return 1;
  return 2;
}

function fuzzyMatches(message, term) {
  const needle = term.toLowerCase();
  const maxDist = allowedEdits(needle);
  if (maxDist === 0) return message.toLowerCase().includes(needle);

  for (const token of message.toLowerCase().split(/\s+/)) {
    if (token.includes(needle)) return true;
    if (withinEditDistance(token, needle, maxDist)) return true;
  }
  return false;
}

function windowStart(period) {
  const days = { day: 1, week: 7, month: 30, all: 365 }[period] ?? 7;
  const start = new Date(Date.now() - days * 86400000);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * Search a channel's chat logs.
 *
 * @param {string} channelLogin        required - the narrowing that makes this affordable
 * @param {object} opts
 * @param {string}   opts.term         keyword; empty = browse the window with no text filter
 * @param {string[]} opts.userIds      optional multi-user filter (capped at MAX_SEARCH_USERS)
 * @param {string}   opts.period       day | week | month | all
 * @param {boolean}  opts.fuzzy        attempt typo-tolerant matching (may be refused - see below)
 * @param {number}   opts.limit
 * @returns {{results, total, truncated, fuzzyApplied, fuzzyRefusedReason, candidateCount}}
 */
async function searchLogs(channelLogin, opts = {}) {
  const { messages } = await ensureInitialized();

  const period = limits.resolvePeriod(opts.period);
  const limit = limits.clampLimit(opts.limit, 50, limits.MAX_SEARCH_RESULTS);
  const term = String(opts.term || "").trim().slice(0, limits.MAX_SEARCH_TERM_LENGTH);
  const userIds = (opts.userIds || []).slice(0, limits.MAX_SEARCH_USERS).map(String);

  // The narrowing filter. This, not the text match, is what the query planner uses.
  const query = { channel: withHash(channelLogin), timestamp: { $gte: windowStart(period) } };
  if (userIds.length === 1) query.userId = userIds[0];
  else if (userIds.length > 1) query.userId = { $in: userIds };

  // How big is the narrowed set? This is answered from the index alone (no document fetches) and
  // is what decides whether fuzzy matching is affordable.
  const candidateCount = await messages.countDocuments(query);

  const project = { projection: { _id: 0, userId: 1, userName: 1, message: 1, timestamp: 1 } };

  // --- Fuzzy path: only when the narrowed set is small enough to scan in Node.
  if (term && opts.fuzzy) {
    if (candidateCount > limits.MAX_SEARCH_FUZZY_CANDIDATES) {
      // Refuse rather than degrade. The UI shows this reason and the exact search still runs.
      const exact = await runExact(messages, query, term, limit, project);
      return {
        ...exact,
        candidateCount,
        fuzzyApplied: false,
        fuzzyRefusedReason: "too_many_candidates",
      };
    }

    const cursor = messages.find(query, project).sort({ timestamp: -1 }).batchSize(1000);
    const results = [];
    for await (const doc of cursor) {
      if (fuzzyMatches(doc.message || "", term)) {
        results.push(doc);
        if (results.length >= limit) break;
      }
    }
    return {
      results,
      total: results.length,
      truncated: results.length >= limit,
      candidateCount,
      fuzzyApplied: true,
      fuzzyRefusedReason: null,
    };
  }

  // --- Exact / substring path (the default).
  const exact = await runExact(messages, query, term, limit, project);
  return { ...exact, candidateCount, fuzzyApplied: false, fuzzyRefusedReason: null };
}

async function runExact(messages, query, term, limit, project) {
  const q = { ...query };
  if (term) q.message = { $regex: escapeRegex(term), $options: "i" };

  const results = await messages.find(q, project).sort({ timestamp: -1 }).limit(limit).toArray();
  return { results, total: results.length, truncated: results.length >= limit };
}

module.exports = { searchLogs, escapeRegex, withinEditDistance, fuzzyMatches, allowedEdits };
