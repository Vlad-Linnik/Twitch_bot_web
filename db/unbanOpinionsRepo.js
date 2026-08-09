// `UnbanExpertOpinions` - the two adversarial speeches printed on the fourth sheet of the Бюро
// амнистии desk: the prosecutor's accusation, the advocate's answer to it, and the prosecutor's one
// edit. One document per case.
//
// WEB-ONLY (connectWeb): the bot never reads this. It is commentary for the moderator at the desk,
// not moderation state - nothing here reaches Twitch, and a case decides identically whether or not
// an opinion was ever written. Keeping it out of the shared db is the same call made for
// UnbanBureauShifts: see ../CLAUDE.md's collections table for what does belong in the shared one.
//
// NOTHING IN THIS APP WRITES IT EITHER. The speeches come from Claude Code running two subagents
// against a brief (GET /admin/api/unban-requests/:id/brief) and are PUT back through the
// bearer-token admin API by a local driver. This site never calls Anthropic and never pays for a
// token; it stores finished text and renders it. See lib/unbanOpinionsValidation.js for the shape
// and why `final` is derived rather than submitted.
const { connectWeb } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UnbanExpertOpinions");
  // One opinion set per case, enforced rather than assumed: the driver is re-runnable by hand and a
  // second run must replace the first sheet, not add a second one the page would pick between
  // arbitrarily.
  await collection.createIndex({ caseId: 1 }, { unique: true });
  // Backs the admin-side "what has been written lately" read; also the index a cleanup sweep would
  // use if these ever need pruning (they are small, so none exists yet).
  await collection.createIndex({ channelId: 1, generatedAt: -1 });
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
 * Writes (or replaces) the opinions for a case.
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
        prosecutor: opinions.prosecutor,
        advocate: opinions.advocate,
        decision: opinions.decision,
        model: opinions.model || null,
        effort: opinions.effort || null,
        // When THIS text was written. A re-run moves it, which is the intent: the sheet should date
        // itself to the speeches it is showing, not to the first time the case was ever argued.
        generatedAt: now,
      },
      $setOnInsert: { caseId: id, firstGeneratedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  // Driver-version-safe unwrap, same idiom as db/unbanRequestsRepo.js's requestDecision().
  return result && result.value !== undefined ? result.value : result;
}

async function deleteByCaseId(caseId) {
  const id = normalizeCaseId(caseId);
  if (!id) return false;
  const col = await ensureInitialized();
  const result = await col.deleteOne({ caseId: id });
  return result.deletedCount > 0;
}

module.exports = { findByCaseId, upsertOpinions, deleteByCaseId };
