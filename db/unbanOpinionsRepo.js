// `UnbanExpertOpinions` - the hearing printed on the fourth sheet of the Бюро амнистии desk: the
// prosecutor's accusation, the advocate's answer, any further speeches the moderator called for, and
// the moderator's own remarks between them. One document per case, holding an ordered `turns` array.
//
// WEB-ONLY (connectWeb): the bot never reads this. It is commentary for the moderator at the desk,
// not moderation state - nothing here reaches Twitch, and a case decides identically whether or not
// an opinion was ever written. Keeping it out of the shared db is the same call made for
// UnbanBureauShifts: see ../CLAUDE.md's collections table for what does belong in the shared one.
//
// THREE THINGS WRITE IT, AND THE SHEET LOOKS THE SAME EITHER WAY. The desk's "заказать разбор"
// button opens the hearing in-process (lib/unbanOpinionsGenerator.js - free on Gemini, ~2 cents on
// the Anthropic fallback; each turn stores which vendor wrote it); "передать слово" appends one more
// speech to it, and the judge's box appends a remark that cost nothing. The fourth path is a person
// arguing the case by hand against a brief (GET /admin/api/unban-requests/:id/brief) on a stronger
// model and PUTting the result back through the bearer-token admin API. That by-hand path is the
// oldest of them and runs its own, fuller prompts (../../.claude/agents/amnesty-*-v4.md) that the
// button deliberately does not: they ask for a register chosen per case and a longer speech than a
// paid turn is worth buying. Whichever wrote it, the text arrives through
// lib/unbanOpinionsValidation.js - see it for the shape, for the field caps, and for why documents
// written before the turns array are adapted on read rather than migrated.
const { connectWeb } = require("./connection");
const { MAX_TURNS } = require("../lib/unbanOpinionsValidation");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connectWeb();
  collection = db.collection("UnbanExpertOpinions");
  // Index creation is in a catch that logs, per ../CLAUDE.md's "a repo's ensureInitialized() must
  // not be able to fail a page render": the handle is cached above, so a throw here would 500 the
  // first request after every restart and silently work on every one after it.
  try {
    // One hearing per case, enforced rather than assumed: the driver is re-runnable by hand and a
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
 * Writes (or replaces) the whole hearing for a case.
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
      $unset: { prosecutor: "", advocate: "" },
      $setOnInsert: { caseId: id, firstGeneratedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  // Driver-version-safe unwrap, same idiom as db/unbanRequestsRepo.js's requestDecision().
  return result && result.value !== undefined ? result.value : result;
}

/**
 * Appends ONE turn to a hearing that already exists - a speech bought with "передать слово", or a
 * remark the moderator typed.
 *
 * THE CEILING IS IN THE FILTER, NOT IN AN `if` ABOVE IT. `turns.<MAX-1>` existing means the array is
 * already full, so a document at the cap simply does not match and the update writes nothing. The
 * caller has usually checked the count already, but that check reads and then writes: two presses in
 * flight against one case would both pass it. This is the one that cannot be raced.
 *
 * A document written under the old two-sided shape has no `turns` array at all, so it is not
 * appendable in place - the caller normalizes it with toTranscript() and rewrites it through
 * upsertOpinions() first. Reported here as `null` rather than fixed silently, because the two paths
 * store different things and guessing between them belongs in the route.
 *
 * @param {string} caseId
 * @param {object} turn  a parsed turn from lib/unbanOpinionsValidation.js
 * @returns {Promise<object|null>} the updated document, or null if it was missing or full
 */
async function appendTurn(caseId, turn) {
  const id = normalizeCaseId(caseId);
  if (!id) throw new Error("caseId required");
  const col = await ensureInitialized();
  const result = await col.findOneAndUpdate(
    {
      caseId: id,
      turns: { $type: "array" },
      [`turns.${MAX_TURNS - 1}`]: { $exists: false },
    },
    {
      $push: { turns: turn },
      $set: { generatedAt: new Date() },
    },
    { returnDocument: "after" }
  );
  const doc = result && result.value !== undefined ? result.value : result;
  return doc || null;
}

async function deleteByCaseId(caseId) {
  const id = normalizeCaseId(caseId);
  if (!id) return false;
  const col = await ensureInitialized();
  const result = await col.deleteOne({ caseId: id });
  return result.deletedCount > 0;
}

module.exports = { findByCaseId, upsertOpinions, appendTurn, deleteByCaseId };
