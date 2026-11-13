// `UnbanExpertOpinions` - what is printed on the fourth sheet of the Бюро амнистии desk. One
// document per case, in one of two shapes (lib/unbanOpinionsValidation.js's header has both):
//   - `summary`: the short sheet the desk writes now - one model call, from the sheet's own button
//     or from the settings page's "ИИ-обзор для всех" (lib/unbanSummaryBatch.js);
//   - `turns[]` (or the older `prosecutor`/`advocate`): a prosecutor/advocate hearing. No longer
//     written by the desk; still written by the by-hand admin PUT (routes/adminApi.js, driven by
//     scripts/local/opinions.js and the V4 agents in ../../.claude/agents/), and still on prod.
// A write of one shape unsets the other, so a document never carries two answers to "what does this
// sheet say".
//
// WEB-ONLY (connectWeb): the bot never reads this. It is commentary for the moderator at the desk,
// not moderation state - nothing here reaches Twitch, and a case decides identically whether or not
// a sheet was ever written. Keeping it out of the shared db is the same call made for
// UnbanBureauShifts: see ../CLAUDE.md's collections table for what does belong in the shared one.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UnbanExpertOpinions");
  // Index creation is in a catch that logs, per ../CLAUDE.md's "a repo's ensureInitialized() must
  // not be able to fail a page render": the handle is cached above, so a throw here would 500 the
  // first request after every restart and silently work on every one after it.
  try {
    // One sheet per case, enforced rather than assumed: the driver is re-runnable by hand and a
    // second run must replace the first sheet, not add a second one the page would pick between
    // arbitrarily.
    await collection.createIndex({ caseId: 1 }, { unique: true });
    // Backs the admin-side "what has been written lately" read; also the index a cleanup sweep would
    // use if these ever need pruning (they are small, so none exists yet).
    await collection.createIndex({ channelId: 1, generatedAt: -1 });
  } catch (err) {
    console.error("[unbanOpinionsRepo] index creation failed:", err.message);
  }
  return collection;
}

// `caseId` is the UnbanRequests _id as a hex STRING, not an ObjectId: it arrives that way from the
// route's :id param and from the driver, this collection is never $lookup-ed against the shared db,
// and one representation end to end is what keeps a lookup from silently missing.
function normalizeCaseId(caseId) {
  return String(caseId || "").trim();
}

async function findByCaseId(caseId) {
  const id = normalizeCaseId(caseId);
  if (!id) return null;
  const col = await ensureInitialized();
  return col.findOne({ caseId: id });
}

/**
 * Writes (or replaces) a whole HEARING for a case - the by-hand admin PUT's path.
 *
 * @param {string} caseId   UnbanRequests _id, hex string
 * @param {{channelId: string|number, channelLogin: string}} channel
 * @param {object} opinions lib/unbanOpinionsValidation.js's parseOpinions().value
 */
async function upsertOpinions(caseId, channel, opinions) {
  const id = normalizeCaseId(caseId);
  if (!id) throw new Error("caseId required");
  const col = await ensureInitialized();
  const now = new Date();
  const result = await col.findOneAndUpdate(
    { caseId: id },
    {
      $set: {
        channelId: String(channel.channelId),
        channelLogin: channel.channelLogin,
        turns: opinions.turns,
        decision: opinions.decision,
        model: opinions.model || null,
        effort: opinions.effort || null,
        // When THIS text was written. A re-run moves it, which is the intent: the sheet should date
        // itself to the speeches it is showing, not to the first time the case was ever argued.
        generatedAt: now,
      },
      // Anything written under the old two-sided shape is dropped on a rewrite rather than left
      // beside the turns it was converted into - a document carrying both would give a future reader
      // two answers to "what does this sheet say", and the adapter's whole point is that there is
      // one.
      $unset: { prosecutor: "", advocate: "", summary: "" },
      $setOnInsert: { caseId: id, firstGeneratedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  // Driver-version-safe unwrap, same idiom as db/unbanRequestsRepo.js's requestDecision().
  return result && result.value !== undefined ? result.value : result;
}

/**
 * Writes (or replaces) the summary for a case.
 *
 * Unsets every hearing field on the way: the only caller that reaches an existing document is a
 * deliberate rewrite, and a document holding a summary AND a transcript would leave the page to pick
 * between them. The single-case route and the batch both refuse a case that already has a sheet, so
 * in practice this only ever inserts.
 *
 * @param {string} caseId   UnbanRequests _id, hex string
 * @param {{channelId: string|number, channelLogin: string}} channel
 * @param {object} summary  lib/unbanOpinionsValidation.js's parseSummary().value
 * @param {{model?: string, effort?: string}} [meta]
 */
async function upsertSummary(caseId, channel, summary, meta = {}) {
  const id = normalizeCaseId(caseId);
  if (!id) throw new Error("caseId required");
  const col = await ensureInitialized();
  const now = new Date();
  const result = await col.findOneAndUpdate(
    { caseId: id },
    {
      $set: {
        channelId: String(channel.channelId),
        channelLogin: channel.channelLogin,
        summary,
        model: meta.model || summary.model || null,
        effort: meta.effort || null,
        generatedAt: now,
      },
      $unset: { turns: "", decision: "", prosecutor: "", advocate: "" },
      $setOnInsert: { caseId: id, firstGeneratedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  return result && result.value !== undefined ? result.value : result;
}

/**
 * Which of these cases already have a sheet of either shape - the batch's "what is left to do".
 * One indexed query (the unique caseId index) instead of one findOne per queued case.
 *
 * @param {string[]} caseIds
 * @returns {Promise<Set<string>>}
 */
async function findCaseIdsWithSheets(caseIds) {
  const ids = [...new Set((caseIds || []).map(normalizeCaseId).filter(Boolean))];
  if (!ids.length) return new Set();
  const col = await ensureInitialized();
  const rows = await col.find({ caseId: { $in: ids } }, { projection: { caseId: 1 } }).toArray();
  return new Set(rows.map((row) => row.caseId));
}

async function deleteByCaseId(caseId) {
  const id = normalizeCaseId(caseId);
  if (!id) return false;
  const col = await ensureInitialized();
  const result = await col.deleteOne({ caseId: id });
  return result.deletedCount > 0;
}

module.exports = { findByCaseId, upsertOpinions, upsertSummary, findCaseIdsWithSheets, deleteByCaseId };
