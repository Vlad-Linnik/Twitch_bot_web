// What the bot has learnt about a channel by itself, plus whatever an admin has written into the
// same list by hand. The bot owns the document shape (TwitchBot/db/aiStore.js writes these rows at
// runtime); this module is the curating half - list, add, delete.
//
// WHY A LIST AND NOT MORE CHEAT SHEET. The admin cheat sheet in ChannelConfig is one block of prose
// stating what the channel is; this is a set of separate facts the bot picked up in chat. Keeping
// them apart is what makes each one curatable on its own - a wrong fact is one row to delete, not a
// paragraph to re-edit - and it means an admin's save can never be overwritten by the bot's next
// reply, or the other way round.
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
  collection = db.collection("AiChannelMemory");
  // Same indexes the bot declares; createIndex is idempotent and whichever side runs first wins.
  await collection.createIndex({ channel: 1, key: 1 }, { unique: true });
  await collection.createIndex({ channel: 1, createdAt: 1 });
  return collection;
}

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

// Oldest first - the same order the bot numbers them in the prompt, so a row's position here is
// the number the model would have used to forget it.
async function listForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.find({ channel: withHash(channelLogin) }).sort({ createdAt: 1 }).toArray();
}

async function countForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.countDocuments({ channel: withHash(channelLogin) });
}

// Returns the stored key, or null when there was nothing usable to store. An admin row is never
// rotated out, so no ceiling is applied here - the ceiling exists to bound what chat can add.
async function addManual(channelLogin, fact, addedBy) {
  const col = await ensureInitialized();
  const text = String(fact ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
  const key = aiTextKey(text);
  if (!key) return null;
  await col.updateOne(
    { channel: withHash(channelLogin), key },
    {
      $set: { fact: text, source: "admin", authorLogin: String(addedBy || ""), updatedAt: new Date() },
      $setOnInsert: {
        channel: withHash(channelLogin),
        key,
        authorUserId: null,
        sourceMessage: null,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
  return key;
}

// Правка факта. Ключ пересчитывается из нового текста - он и есть защита от дублей, и оставить
// его от старого текста значило бы, что два разных факта считаются одним.
//
// Отредактированная строка становится admin-строкой: человек её переписал, значит ручается за
// неё, а такие не вытесняются ротацией и всегда уходят в запрос. Кто её надиктовал изначально,
// сохраняется в authorLogin/sourceMessage - это провенанс, а не авторство текста.
//
// Возвращает { ok } либо { ok:false, reason:'duplicate'|'empty' }: столкновение ключей - не сбой,
// а обычный исход, когда факт правят к тому, что уже записано.
async function updateFact(channelLogin, key, fact, editedBy) {
  const col = await ensureInitialized();
  const channel = withHash(channelLogin);
  const text = String(fact ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
  const nextKey = aiTextKey(text);
  if (!nextKey) return { ok: false, reason: "empty" };

  if (nextKey !== String(key)) {
    const clash = await col.findOne({ channel, key: nextKey });
    if (clash) return { ok: false, reason: "duplicate" };
  }
  const res = await col.updateOne(
    { channel, key: String(key) },
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

async function remove(channelLogin, key) {
  const col = await ensureInitialized();
  await col.deleteOne({ channel: withHash(channelLogin), key: String(key) });
}

async function clearChannel(channelLogin) {
  const col = await ensureInitialized();
  const res = await col.deleteMany({ channel: withHash(channelLogin) });
  return res.deletedCount || 0;
}

module.exports = { MAX_FACT_LEN, listForChannel, countForChannel, addManual, updateFact, remove, clearChannel };
