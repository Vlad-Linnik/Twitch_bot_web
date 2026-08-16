// CRUD for the `AutoAnswers` collection - the moderator-authored topics behind
// /<channel>/auto-answers.
//
// OWNERSHIP: this app owns and writes it; the bot only READS (its own
// TwitchBot/db/autoAnswersRepo.js, mode !== "off"). Same direction as ChannelConfig, and the
// opposite of custom_commands/counters - there is no chat command that creates a topic, so
// nothing on the bot side ever writes here. That asymmetry is deliberate: a topic is a piece
// of editorial judgement ("chat keeps asking X, here is the one answer"), not a chat action.
//
// It lives in the SHARED database rather than the web-only one precisely because the bot
// reads it. Its sibling `AutoAnswerHits` runs the other way - bot writes, we read.
//
// DOCUMENT SHAPE (ours, but the bot depends on it - change both sides together):
//   {
//     channel: '#login',        // WITH the hash, matching `messages` / `ChatWordStats`
//     title, answer,            // what the moderator called it, and what the bot says
//     examples: [],             // real questions this was built from
//     antiExamples: [],         // messages it must NOT fire on (the «не то» button)
//     requiredStems, optionalStems, excludeStems, notQuestionStems,
//     requireQuestion: true,
//     mode: 'off' | 'test' | 'live',
//     cooldownSeconds,
//     createdAt, updatedAt, createdBy: { userId, login }
//   }
//
// `mode` is ONE field with three values rather than an `enabled` flag plus a mode, because
// "disabled but live" is not a state that means anything. "off" is also the archive: a topic
// that is done stays in the list, inert, ready to switch back on when the question returns.
// There is deliberately no expiry date: "the question stopped being asked" is a judgement call,
// not a timer, and a topic that auto-expired would go quiet without anyone noticing.
const { ObjectId } = require("mongodb");
const { connect } = require("./connection");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AutoAnswers");
  // The bot's read is "every live/test topic of the channels I joined", on a refresh tick.
  await collection.createIndex({ channel: 1, mode: 1 });
  return collection;
}

const withHash = (channelLogin) => `#${String(channelLogin).toLowerCase().replace(/^#/, "")}`;

const toObjectId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null; // a malformed id from the URL is "not found", never a 500
  }
};

async function list(channelLogin) {
  const col = await ensureInitialized();
  return col.find({ channel: withHash(channelLogin) }).sort({ updatedAt: -1 }).toArray();
}

async function findById(channelLogin, id) {
  const _id = toObjectId(id);
  if (!_id) return null;
  const col = await ensureInitialized();
  return col.findOne({ _id, channel: withHash(channelLogin) });
}

async function create(channelLogin, topic, user) {
  const col = await ensureInitialized();
  const now = new Date();
  const doc = {
    ...topic,
    channel: withHash(channelLogin),
    createdAt: now,
    updatedAt: now,
    createdBy: user ? { userId: user.userId, login: user.login } : null,
  };
  const res = await col.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function update(channelLogin, id, topic) {
  const _id = toObjectId(id);
  if (!_id) return null;
  const col = await ensureInitialized();
  await col.updateOne(
    { _id, channel: withHash(channelLogin) },
    { $set: { ...topic, updatedAt: new Date() } }
  );
  return findById(channelLogin, id);
}

/**
 * Add one message to a topic's anti-examples - what the «не то» button on the hits feed does.
 *
 * $addToSet rather than $push: the same false positive can be clicked twice (two moderators,
 * or one moderator revisiting the feed), and a duplicated anti-example would silently double
 * its weight in the rule-conflict report.
 */
async function addAntiExample(channelLogin, id, text) {
  const _id = toObjectId(id);
  if (!_id) return null;
  const col = await ensureInitialized();
  await col.updateOne(
    { _id, channel: withHash(channelLogin) },
    { $addToSet: { antiExamples: text }, $set: { updatedAt: new Date() } }
  );
  return findById(channelLogin, id);
}

async function remove(channelLogin, id) {
  const _id = toObjectId(id);
  if (!_id) return false;
  const col = await ensureInitialized();
  const res = await col.deleteOne({ _id, channel: withHash(channelLogin) });
  return res.deletedCount > 0;
}

module.exports = { list, findById, create, update, addAntiExample, remove, withHash };
