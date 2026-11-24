// Web-only: DonationMediaActions, who did what to a channel's donation media queue
// (lib/donationMediaActionLog.js says what is logged and what an entry holds):
//   { channelId, at, by, byId, via: "site" | "dock" | "chat", action, video, detail }
// `by` is a login; a dock has no login, so its rows carry by "OBS" and byId null.
const { ObjectId } = require("mongodb");
const { connectWeb } = require("./connection");

const KEEP_S = 90 * 24 * 60 * 60;
const PAGE = 50;

let col;

async function ensureInitialized() {
  if (col) return col;
  const actions = (await connectWeb()).collection("DonationMediaActions");
  // A failed createIndex must not fail the caller (../CLAUDE.md, "A repo's ensureInitialized()").
  try {
    await Promise.all([actions.createIndex({ channelId: 1, _id: -1 }), actions.createIndex({ at: 1 }, { expireAfterSeconds: KEEP_S })]);
  } catch (err) {
    console.error("[donationMediaActionsRepo] createIndex failed:", err.message);
  }
  col = actions;
  return col;
}

const newId = () => new ObjectId();

async function save(row) {
  const actions = await ensureInitialized();
  await actions.replaceOne({ _id: row._id }, row, { upsert: true });
}

// Newest first. `before`: a row's id to continue after; `by`: one person's rows only.
async function list(channelId, { before = null, by = null } = {}) {
  const actions = await ensureInitialized();
  const query = { channelId: String(channelId) };
  if (by) query.by = by;
  if (before && /^[0-9a-f]{24}$/.test(before)) query._id = { $lt: new ObjectId(before) };
  const rows = await actions.find(query).sort({ _id: -1 }).limit(PAGE + 1).toArray();
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

async function people(channelId) {
  const actions = await ensureInitialized();
  return (await actions.distinct("by", { channelId: String(channelId) })).sort((a, b) => a.localeCompare(b));
}

module.exports = { newId, save, list, people };
