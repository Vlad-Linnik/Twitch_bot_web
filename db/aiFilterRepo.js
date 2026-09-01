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
      // Строку, написанную человеком, согласовывать не у кого - она уже согласована тем, что её
      // написали. Флаг ставится и при правке ботовской строки: разобрать её и есть согласование.
      $set: { answer: reply, source: source || "admin", approved: true },
      $setOnInsert: { channel: withHash(channel), text: key, hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
  return key;
}

// Правка СУЩЕСТВУЮЩЕЙ строки, отдельно от upsert() - вопросы разные. upsert говорит «пусть на
// этот текст будет такой ответ» и заводит строку, если её нет; здесь правится конкретная строка,
// у которой может смениться и сам текст.
//
// Переименование делается на месте ($set ключа), а не удалением со вставкой: иначе строка теряет
// hits и createdAt, то есть ровно то, по чему через месяц видно, живая она или мёртвая. Та же
// схема, что у updateFact в db/aiMemoryRepo.js.
//
// Столкновение с уже существующей строкой - отказ, а не слияние. Слияние молча стёрло бы чужой
// ответ, и заметить это можно было бы только по тому, что строк стало на одну меньше.
async function updateEntry({ channelLogin, text, newText, answer }) {
  const col = await ensureInitialized();
  const channel = withHash(String(channelLogin || ""));
  const nextKey = aiTextKey(newText);
  const reply = String(answer ?? "").trim();
  // Пустой ответ здесь запрещён по той же причине, что и в upsert(): бот отдаёт строку фильтра
  // не спрашивая модель, поэтому пустая строка засчитывает попадание и всё равно проваливается
  // дальше - в панели это выглядит как работающая запись.
  if (!nextKey || !reply) return { ok: false, reason: "empty" };
  if (nextKey !== String(text)) {
    const clash = await col.findOne({ channel, text: nextKey });
    if (clash) return { ok: false, reason: "duplicate" };
  }
  // source становится "admin" по той же причине, что и в upsert(): исправленный ответ написал
  // человек, и колонка «кем добавлено» должна отвечать на единственный вопрос, ради которого она
  // есть, - чей это текст.
  const res = await col.updateOne(
    { channel, text: String(text) },
    { $set: { text: nextKey, answer: reply, source: "admin", approved: true } }
  );
  if (!res.matchedCount) return { ok: false, reason: "failed" };
  return { ok: true, key: nextKey };
}

// СОГЛАСОВАНИЕ. Бот отдаёт из фильтра только строки с approved: true - см. findFilterAnswer в
// TwitchBot/db/aiStore.js. Заготовка отвечает вечно, всем и без модели, а заводит её один разговор
// с одним человеком, поэтому между «модель предложила» и «отвечает в чат» стоит человек. Та же
// стадия, что у наказаний (observe → enforce) и у античита.
//
// Снятие согласования - не удаление: строку бывает нужно выключить, не теряя ни текста, ни hits,
// по которым видно, работала она вообще или нет.
async function setApproved(channelLogin, text, approved) {
  const col = await ensureInitialized();
  const res = await col.updateOne(
    { channel: withHash(channelLogin), text: aiTextKey(text) },
    { $set: { approved: Boolean(approved) } }
  );
  return res.matchedCount > 0;
}

// Сколько строк ждёт разбора - для значка в списке разделов. Строки, заведённые до появления
// флага, попадают сюда же: approved у них нет вовсе, и отвечать они перестали.
async function countPending(channelLogin) {
  const col = await ensureInitialized();
  const where = { approved: { $ne: true } };
  if (channelLogin) where.channel = withHash(channelLogin);
  return col.countDocuments(where);
}

async function remove(channelLogin, text) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel: withHash(channelLogin), text: aiTextKey(text) });
}

module.exports = {
  listForChannel,
  count,
  countForChannel,
  countPending,
  upsert,
  updateEntry,
  setApproved,
  remove,
};
