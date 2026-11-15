// «Премия чата» storage - lib/chatAwards.js holds the rules. Web db (connectWeb), except the one
// read of the shared `messages` that decides whether a viewer may vote.
//
//   ChatAwards      _id "<login>:<year>" - the frozen ballot. Written once, by whichever request
//                   first needs it after voting opens; insert-only, so two requests racing to
//                   freeze it cannot leave two different ballots behind
//   ChatAwardVotes  _id "<login>:<year>:<userId>:<award>" - one vote per person per award; voting
//                   again replaces it until the window closes
const { connect, connectWeb } = require("./connection");

let cols = null;

async function ensureInitialized() {
  if (cols) return cols;
  const db = await connectWeb();
  cols = { ballots: db.collection("ChatAwards"), votes: db.collection("ChatAwardVotes") };
  try {
    await cols.votes.createIndex({ channelLogin: 1, year: 1, userId: 1 });
  } catch (err) {
    console.error("[chatAwardsRepo] index creation failed:", err.message);
  }
  return cols;
}

const ballotId = (login, year) => `${String(login).toLowerCase()}:${year}`;

async function getBallot(login, year) {
  const { ballots } = await ensureInitialized();
  return ballots.findOne({ _id: ballotId(login, year) });
}

// Freezes `ballot` unless one is already frozen; returns whichever is stored.
async function freezeBallot(login, year, ballot) {
  const { ballots } = await ensureInitialized();
  try {
    await ballots.insertOne({
      _id: ballotId(login, year),
      channelLogin: String(login).toLowerCase(),
      year,
      frozenAt: new Date(),
      ballot,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return getBallot(login, year);
}

async function castVote(login, year, userId, key, nomineeId) {
  const { votes } = await ensureInitialized();
  const channelLogin = String(login).toLowerCase();
  await votes.replaceOne(
    { _id: `${ballotId(login, year)}:${userId}:${key}` },
    { channelLogin, year, userId: String(userId), key, nomineeId: String(nomineeId), at: new Date() },
    { upsert: true }
  );
}

// { [award]: nomineeId } for one voter.
async function votesOf(login, year, userId) {
  const { votes } = await ensureInitialized();
  const rows = await votes
    .find({ channelLogin: String(login).toLowerCase(), year, userId: String(userId) })
    .project({ _id: 0, key: 1, nomineeId: 1 })
    .toArray();
  return Object.fromEntries(rows.map((r) => [r.key, r.nomineeId]));
}

// [{ key, nomineeId, n }] - the tally, for lib/chatAwards.js's results().
async function tally(login, year) {
  const { votes } = await ensureInitialized();
  const rows = await votes
    .aggregate([
      { $match: { channelLogin: String(login).toLowerCase(), year } },
      { $group: { _id: { key: "$key", nomineeId: "$nomineeId" }, n: { $sum: 1 } } },
    ])
    .toArray();
  return rows.map((r) => ({ key: r._id.key, nomineeId: r._id.nomineeId, n: r.n }));
}

async function voterCount(login, year) {
  const { votes } = await ensureInitialized();
  return (await votes.distinct("userId", { channelLogin: String(login).toLowerCase(), year })).length;
}

// Whether `userId` wrote at least `min` messages in the channel during [start, end). Stops counting
// at `min`, so even the year's most active chatter costs a short indexed read.
async function hasMessages(login, userId, start, end, min) {
  const db = await connect();
  const n = await db.collection("messages").countDocuments(
    { channel: `#${String(login).toLowerCase()}`, userId: String(userId), timestamp: { $gte: start, $lt: end } },
    { limit: min }
  );
  return n >= min;
}

module.exports = { getBallot, freezeBallot, castVote, votesOf, tally, voterCount, hasMessages };
