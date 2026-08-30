// Отношение бота к конкретным зрителям: одно число от -10 до +10 на пару {канал, человек}.
//
// Форму документа владеет бот (TwitchBot/db/aiStore.js пишет эти строки на ходу), здесь -
// курирующая половина: посмотреть, поправить руками, сбросить. Та же пара ролей, что у
// db/aiUserMemoryRepo.js, и заведена она по тому же правилу: в коллекцию, которой владеет бот, сайт
// не пишет иначе как через отдельный модуль репозитория, потому что именно он и есть место, где
// записан договор о форме строки.
//
// ЧТО ЭТО ЧИСЛО ЗНАЧИТ И ПОЧЕМУ ОНО ОДНО. Из него следуют сразу три вещи: терпение (пока отношение
// выше границы, вердикт timeout выдаёт предупреждение, а не мут), срок мута (чем ниже, тем дольше) и
// дружба. Вся арифметика - в lib/rapport.js, ручной копии TwitchBot/shared/rapport.js; здесь её нет
// намеренно, иначе копий стало бы три.
//
// РУЧНАЯ ПРАВКА НЕ БЛОКИРУЕТ БОТА. Выставленный здесь счёт помечается source: "admin", но остаётся
// обычным значением шкалы: бот продолжит его двигать. Пометка отвечает на вопрос «откуда взялось
// это число», а не «трогать нельзя» - замок, который нельзя снять, означал бы, что человека,
// однажды поправленного руками, отношения больше не касаются вовсе.
const { connect } = require("./connection");
const rapport = require("../lib/rapport");

let collection;

async function ensureInitialized() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection("AiUserRapport");
  // Те же индексы, что объявляет бот; createIndex идемпотентен, и кто первый дошёл, тот и создал.
  await collection.createIndex({ channel: 1, userId: 1 }, { unique: true });
  await collection.createIndex({ channel: 1, score: 1 });
  return collection;
}

const withHash = (login) => (login.startsWith("#") ? login.toLowerCase() : `#${login.toLowerCase()}`);

// Сортировка по счёту, а не по дате: интересны края шкалы - те, кого бот вот-вот замутит надолго, и
// те, кого записал в друзья. Середина - это все остальные, и смотреть там нечего.
//
// `willBe` считается здесь же, копией правил бота: страница отвечает на вопрос «что будет этому
// человеку за следующее нарушение», и ответ на него - предупреждение или мут на столько-то секунд.
// Без этой колонки число на странице ни о чём не говорит.
async function listForChannel(channelLogin, config) {
  const col = await ensureInitialized();
  const rows = await col.find({ channel: withHash(channelLogin) }).sort({ score: 1 }).toArray();
  const base = Number(config && config.timeoutSeconds) || 0;
  const max = Number(config && config.rapportMaxMultiplier) || 1;
  return rows.map((row) => {
    const score = rapport.clampScore(row.score);
    const action = rapport.decide(score);
    return {
      ...row,
      score,
      label: rapport.describe(score),
      action,
      willBeSeconds: action === "timeout" ? rapport.timeoutSeconds(base, score, max) : null,
    };
  });
}

async function countForChannel(channelLogin) {
  const col = await ensureInitialized();
  return col.countDocuments({ channel: withHash(channelLogin) });
}

// Правка руками. Строка может ещё не существовать: отношение заводится только на том, кто дожил до
// платного вызова, а выставить его наперёд - обычное желание («этого больше не трогать», «этому
// поменьше терпения»). Поэтому upsert, а не update.
async function setScore(channelLogin, userId, login, score, editedBy) {
  const col = await ensureInitialized();
  const channel = withHash(channelLogin);
  const id = String(userId || "");
  if (!id) return null;
  const value = rapport.clampScore(score);
  // Дружба - следствие счёта, а не отдельная галка, поэтому пересчитывается тут же. Отметку «уже
  // объявлено» ручная правка снимает: если счёт подняли до дружбы руками, сказать об этом человеку
  // бот ещё не успел.
  const friendship = rapport.friendState(false, value);
  await col.updateOne(
    { channel, userId: id },
    {
      $set: {
        score: value,
        friend: friendship.friend,
        friendAnnounced: false,
        source: "admin",
        editedBy: String(editedBy || ""),
        updatedAt: new Date(),
        ...(login ? { login: String(login).toLowerCase() } : {}),
      },
      $setOnInsert: {
        channel,
        userId: id,
        seededFrom: null,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
  return value;
}

// Удаление, а не обнуление. Это разные вещи: ноль - законное значение шкалы и осознанное «отношусь
// нейтрально», а отсутствие строки означает «человека здесь ещё не было», и при включённом общем
// пуле следующий его вопрос снова засеет счёт из соседнего канала. Кнопка на странице называется
// соответственно.
async function remove(channelLogin, userId) {
  const col = await ensureInitialized();
  const res = await col.deleteOne({ channel: withHash(channelLogin), userId: String(userId) });
  return Boolean(res.deletedCount);
}

async function clearChannel(channelLogin) {
  const col = await ensureInitialized();
  const res = await col.deleteMany({ channel: withHash(channelLogin) });
  return res.deletedCount || 0;
}

module.exports = {
  MIN_SCORE: rapport.MIN_SCORE,
  MAX_SCORE: rapport.MAX_SCORE,
  listForChannel,
  countForChannel,
  setScore,
  remove,
  clearChannel,
};
