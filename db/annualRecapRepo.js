// Storage of the annual recap (/:channel/recap). Web db (connectWeb): the recap is computed FROM
// the bot's collections, but nothing in it is read back by the bot.
//
//   AnnualRecaps         one document per channel and year, _id "<login>:<year>" - the whole
//                        channel recap as jobs/annualRecap.js built it
//   AnnualRecapMentions  {channelLogin, year, from, to, n} - who @-ed whom this year. Kept out of
//                        the recap document because it is tens of thousands of rows and the
//                        personal page needs only the ones pointing at one person
//   AnnualRecapUsers     the personal recap cache, _id "<login>:<year>:<userId>". Valid while its
//                        `basedOn` equals the channel recap's builtAt; a rebuild invalidates all
//   AnnualRecapOptOut    {_id: userId} - "leave me out of the public recap", for every channel
const { connectWeb } = require("./connection");

let cols = null;

async function ensureInitialized() {
  if (cols) return cols;
  const db = await connectWeb();
  cols = {
    recaps: db.collection("AnnualRecaps"),
    mentions: db.collection("AnnualRecapMentions"),
    users: db.collection("AnnualRecapUsers"),
    optOut: db.collection("AnnualRecapOptOut"),
  };
  // Logged, never thrown: an index failure must not 500 the first page after a restart (the
  // handle above is already cached, so every later request would quietly work).
  try {
    await Promise.all([
      cols.mentions.createIndex({ channelLogin: 1, year: 1, to: 1 }),
      cols.mentions.createIndex({ channelLogin: 1, year: 1, from: 1 }),
      cols.recaps.createIndex({ channelLogin: 1, year: -1 }),
    ]);
  } catch (err) {
    console.error("[annualRecapRepo] index creation failed:", err.message);
  }
  return cols;
}

const recapId = (login, year) => `${String(login).toLowerCase()}:${year}`;

async function saveChannelRecap(login, year, data) {
  const { recaps } = await ensureInitialized();
  const doc = { channelLogin: String(login).toLowerCase(), year, builtAt: new Date(), data };
  await recaps.replaceOne({ _id: recapId(login, year) }, doc, { upsert: true });
  return doc;
}

async function getChannelRecap(login, year) {
  const { recaps } = await ensureInitialized();
  return recaps.findOne({ _id: recapId(login, year) });
}

// Years that have a built recap, newest first.
async function listYears(login) {
  const { recaps } = await ensureInitialized();
  const rows = await recaps
    .find({ channelLogin: String(login).toLowerCase() })
    .project({ year: 1, builtAt: 1 })
    .sort({ year: -1 })
    .toArray();
  return rows.map((r) => ({ year: r.year, builtAt: r.builtAt }));
}

// Map<channelLogin, builtAt> of every recap built for `year` - the admin table's caption.
async function builtAtForYear(year) {
  const { recaps } = await ensureInitialized();
  const rows = await recaps.find({ year }).project({ channelLogin: 1, builtAt: 1 }).toArray();
  return new Map(rows.map((r) => [r.channelLogin, r.builtAt]));
}

async function replaceMentions(login, year, rows) {
  const { mentions } = await ensureInitialized();
  const channelLogin = String(login).toLowerCase();
  await mentions.deleteMany({ channelLogin, year });
  const CHUNK = 5000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await mentions.insertMany(
      rows.slice(i, i + CHUNK).map((r) => ({ channelLogin, year, from: r.from, to: r.to, n: r.n })),
      { ordered: false }
    );
  }
}

// Mentions pointing at any of `logins` (a person may have been renamed during the year).
async function mentionsOf(login, year, logins) {
  const { mentions } = await ensureInitialized();
  return mentions
    .find({ channelLogin: String(login).toLowerCase(), year, to: { $in: logins } })
    .project({ _id: 0, from: 1, to: 1, n: 1 })
    .toArray();
}

async function getUserRecap(login, year, userId) {
  const { users } = await ensureInitialized();
  return users.findOne({ _id: `${recapId(login, year)}:${userId}` });
}

async function saveUserRecap(login, year, userId, basedOn, data) {
  const { users } = await ensureInitialized();
  await users.replaceOne(
    { _id: `${recapId(login, year)}:${userId}` },
    { channelLogin: String(login).toLowerCase(), year, userId: String(userId), basedOn, builtAt: new Date(), data },
    { upsert: true }
  );
}

async function clearUserRecaps(login, year) {
  const { users } = await ensureInitialized();
  await users.deleteMany({ channelLogin: String(login).toLowerCase(), year });
}

async function isOptedOut(userId) {
  if (!userId) return false;
  const { optOut } = await ensureInitialized();
  return Boolean(await optOut.findOne({ _id: String(userId) }));
}

async function setOptOut(userId, hidden) {
  const { optOut } = await ensureInitialized();
  if (hidden) {
    await optOut.updateOne({ _id: String(userId) }, { $set: { at: new Date() } }, { upsert: true });
  } else {
    await optOut.deleteOne({ _id: String(userId) });
  }
}

// The subset of `userIds` that asked to be left out. One read per page render.
async function optedOutAmong(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) return new Set();
  const { optOut } = await ensureInitialized();
  const rows = await optOut.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray();
  return new Set(rows.map((r) => r._id));
}

module.exports = {
  saveChannelRecap,
  getChannelRecap,
  listYears,
  builtAtForYear,
  replaceMentions,
  mentionsOf,
  getUserRecap,
  saveUserRecap,
  clearUserRecaps,
  isOptedOut,
  setOptOut,
  optedOutAmong,
};
