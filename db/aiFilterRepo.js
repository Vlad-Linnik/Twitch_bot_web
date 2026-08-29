// "This message is not worth an API call" - message text mapped to a canned reply, checked before
// the model is ever contacted. Rows are added both by the model itself (when it decides a message
// did not deserve the call it just cost) and by hand from the admin panel.
//
// ПО КАНАЛАМ. Раньше таблица была общей на все каналы - «привет» значит одно и то же везде, и
// заново учить этому каждый канал казалось расточительным. Отказались вот почему: строки сюда
// пишет сама модель (вердикт filter), и в общей таблице придуманная ею заготовка начинала
// выдаваться во всех чатах бота сразу, навсегда и без чьего-либо просмотра. На проде так появился
// ответ, которому в чужом канале делать нечего.
//
// Экономия, ради которой всё затевалось, оказалась мнимой: за месяцы работы в таблице накопилось
// девять строк, то есть «переучивание» стоит девять вызовов на канал. Утечка стоит дороже.
//
// hits/lastHitAt exist so the list stays prunable. Without them a table that only ever grows is
// impossible to review a month later - there is no way to tell a live entry from a dead one.
const { connect } = require("./connection");
const { aiTextKey } = require("../lib/aiTextKey");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiFilter");
  await collection.createIndex({ channel: 1, text: 1 }, { unique: true });
  await collection.createIndex({ channel: 1, hits: -1 });
  return collection;
}

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

async function listForChannel(channelLogin, { limit = 500 } = {}) {
  const col = await ensureInitialized();
  return col.find({ channel: withHash(channelLogin) }).sort({ hits: -1, _id: -1 }).limit(limit).toArray();
}

async function count() {
  const col = await ensureInitialized();
  return col.countDocuments({});
}

async function countForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.countDocuments({ channel: withHash(channelLogin) });
}

// source: "ai" (the model added it after answering) or "admin" (added by hand).
//
// An empty answer is refused rather than stored. The bot serves a filter row without calling the
// model, so a blank one is a row that counts a hit and then falls through to the model anyway -
// invisible in the panel, which shows only that the entry exists and is being hit. The form marks
// both fields required; this is the server-side half of the same rule.
//
// `source` is $set, not $setOnInsert: correcting a row the model wrote makes it an admin row, and
// leaving it attributed to the bot would mean the "added by" column stops answering the only
// question it is there for - whose text is this.
async function upsert({ channelLogin, text, answer, source }) {
  const col = await ensureInitialized();
  const key = aiTextKey(text);
  const reply = String(answer ?? "").trim();
  const channel = String(channelLogin || "").trim();
  if (!key || !reply || !channel) return null;
  await col.updateOne(
    { channel: withHash(channel), text: key },
    {
      $set: { answer: reply, source: source || "admin" },
      $setOnInsert: { channel: withHash(channel), text: key, hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
  return key;
}

async function remove(channelLogin, text) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel: withHash(channelLogin), text: aiTextKey(text) });
}

module.exports = { listForChannel, count, countForChannel, upsert, remove };
