// What the bot has learnt about individual viewers, plus whatever an admin has written into the
// same list by hand. The bot owns the document shape (TwitchBot/db/aiStore.js writes these rows at
// runtime); this module is the curating half - list, add, edit, delete.
//
// WHY A SECOND COLLECTION AND NOT A FIELD ON AiChannelMemory. These facts have an addressee. A
// channel fact rides along with every billed call for that channel; a fact about one person is
// wanted exactly when that person is talking or when someone asked about them, and that difference
// is the whole saving. One table for both would mean either carrying every viewer's memory into
// every request, or adding a "who is it about" field - which is this collection, minus the index.
//
// THE SUBJECT AND THE AUTHOR ARE DIFFERENT PEOPLE. Anyone in the conversation can teach the bot
// something about anyone else who is in it, so `userId`/`login` is who the fact is ABOUT while
// `authorLogin`/`authorRole`/`sourceMessage` is who said it. A disputed row cannot be judged
// without the second half, which is why both are on every row and why this page shows them.
//
// Rows carry `source`: "ai" for what the bot wrote, "admin" for what was typed here. The bot's
// rotation only ever evicts its own rows, so an admin-written fact stays until it is deleted here.
const { connect } = require("./connection");
const { aiTextKey } = require("../lib/aiTextKey");

const MAX_FACT_LEN = 200;

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiUserMemory");
  // Same indexes the bot declares; createIndex is idempotent and whichever side runs first wins.
  await collection.createIndex({ channel: 1, userId: 1, key: 1 }, { unique: true });
  await collection.createIndex({ channel: 1, userId: 1, createdAt: 1 });
  return collection;
}

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

// Grouped by the person the facts are about, because that is the unit being curated: a viewer is
// either someone the bot should know things about or someone it should not, and deciding that one
// row at a time out of a flat list means reading the same login twenty times.
//
// Sorted by who the bot knows most about, then by login. Not by date: the interesting rows are the
// people with a story attached, and they are exactly the ones with several facts.
async function listForChannel(channelLogin) {
  const col = await ensureInitialized();
  const rows = await col
    .find({ channel: withHash(channelLogin) })
    .sort({ createdAt: 1 })
    .toArray();

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.userId)) {
      groups.set(row.userId, { userId: row.userId, login: row.login || "", facts: [] });
    }
    const group = groups.get(row.userId);
    // Ник переписывается ботом при каждой записи, поэтому свежая строка знает его лучше старой.
    if (row.login) group.login = row.login;
    group.facts.push(row);
  }
  return [...groups.values()].sort(
    (a, b) => b.facts.length - a.facts.length || a.login.localeCompare(b.login)
  );
}

async function countForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.countDocuments({ channel: withHash(channelLogin) });
}

// Returns the stored key, or null when there was nothing usable to store. An admin row is never
// rotated out, so no ceiling is applied here - the ceiling exists to bound what chat can add.
//
// The caller resolves the login to a userId first (db/userStatsRepo.findUserByName): the row is
// keyed by id because logins change, and a fact written against a name the bot has never seen
// would never be read back.
async function addManual(channelLogin, subject, fact, addedBy) {
  const col = await ensureInitialized();
  const userId = String(subject && subject.userId ? subject.userId : "");
  const text = String(fact ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
  const key = aiTextKey(text);
  if (!key || !userId) return null;
  await col.updateOne(
    { channel: withHash(channelLogin), userId, key },
    {
      $set: {
        fact: text,
        login: String(subject.login || "").toLowerCase(),
        source: "admin",
        authorLogin: String(addedBy || ""),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        channel: withHash(channelLogin),
        userId,
        key,
        authorUserId: null,
        sourceMessage: null,
        createdAt: new Date(),
        lastUsedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return key;
}

// Правка факта. Ключ пересчитывается из нового текста - он и есть защита от дублей, и оставить его
// от старого текста значило бы, что два разных факта считаются одним.
//
// Отредактированная строка становится admin-строкой: человек её переписал, значит ручается за неё,
// а такие не вытесняются ротацией. Кто её надиктовал изначально, сохраняется в authorLogin и
// sourceMessage - это провенанс, а не авторство текста.
//
// Возвращает { ok } либо { ok:false, reason:'duplicate'|'empty' }: столкновение ключей - не сбой, а
// обычный исход, когда факт правят к тому, что уже записано.
async function updateFact(channelLogin, userId, key, fact, editedBy) {
  const col = await ensureInitialized();
  const channel = withHash(channelLogin);
  const owner = String(userId || "");
  const text = String(fact ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
  const nextKey = aiTextKey(text);
  if (!nextKey) return { ok: false, reason: "empty" };

  if (nextKey !== String(key)) {
    const clash = await col.findOne({ channel, userId: owner, key: nextKey });
    if (clash) return { ok: false, reason: "duplicate" };
  }
  const res = await col.updateOne(
    { channel, userId: owner, key: String(key) },
    {
      $set: {
        fact: text,
        key: nextKey,
        source: "admin",
        editedBy: String(editedBy || ""),
        updatedAt: new Date(),
      },
    }
  );
  return { ok: res.matchedCount > 0 };
}

async function remove(channelLogin, userId, key) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel: withHash(channelLogin), userId: String(userId), key: String(key) });
}

// Всё, что бот знает про одного человека. Отдельная кнопка от «очистить канал» именно потому, что
// спорной обычно оказывается память про конкретного зрителя, а не про всех сразу.
async function clearUser(channelLogin, userId) {
  const col = await ensureInitialized();
  const res = await col.deleteMany({ channel: withHash(channelLogin), userId: String(userId) });
  return res.deletedCount || 0;
}

async function clearChannel(channelLogin) {
  const col = await ensureInitialized();
  const res = await col.deleteMany({ channel: withHash(channelLogin) });
  return res.deletedCount || 0;
}

module.exports = {
  MAX_FACT_LEN,
  listForChannel,
  countForChannel,
  addManual,
  updateFact,
  remove,
  clearUser,
  clearChannel,
};
