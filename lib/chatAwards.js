// «Премия чата» (/:channel/recap/:year/awards): the rules. The code picks the nominees from the
// year's recap, the chat picks the winners.
//
// Three decisions shape it, none of them derivable from the code:
//  - nominees are COMPUTED, never proposed: every nomination is a top list the recap already has,
//    so nobody campaigns to get on the ballot and nothing typed by a viewer ends up on it;
//  - voting is open on fixed dates, 1-25 December on the audience's clock - a recap of the year
//    that is still running needs the year mostly over, and the last week is left for announcing;
//  - a voter needs MIN_VOTER_MESSAGES in that chat that year. Logging in alone is one click per
//    twink account; fifty messages is nothing for anyone who actually lives in the chat.
//
// The ballot is frozen the first time it is needed once voting opens: the recap keeps rebuilding
// through December, and a nominee list that reshuffles under votes already cast would void them.
const { TZ_OFFSET_MS } = require("./annualRecap");

const MIN_VOTER_MESSAGES = 50;
const NOMINEES_PER_AWARD = 5;
// A nomination with fewer candidates than this is not a contest.
const MIN_NOMINEES = 2;

const AWARDS = ["voice", "pair", "word", "emote", "opener", "moment"];

function awardsWindow(year) {
  return {
    opens: new Date(Date.UTC(year, 11, 1) - TZ_OFFSET_MS),
    closes: new Date(Date.UTC(year, 11, 26) - TZ_OFFSET_MS),
  };
}

function phaseOf(year, now = new Date()) {
  const { opens, closes } = awardsWindow(year);
  const t = new Date(now).getTime();
  if (t < opens.getTime()) return "soon";
  if (t < closes.getTime()) return "open";
  return "closed";
}

// The ballot from a channel recap's data. `hidden` - user ids that left the public recap; they are
// not nominated, and a pair with one of them is not either. `nameOf(userId)` names a person the
// recap stored only by id (first chatters outside the top list).
function buildBallot(data, { hidden = new Set(), nameOf = () => null } = {}) {
  const visible = (id) => !id || !hidden.has(String(id));
  const take = (list) => list.slice(0, NOMINEES_PER_AWARD);
  const ballot = [];
  const topNames = new Map(data.topChatters.map((u) => [String(u.userId), u.name]));
  const nameFor = (id) => topNames.get(String(id)) || nameOf(id) || String(id);

  const add = (key, nominees) => {
    if (nominees.length >= MIN_NOMINEES) ballot.push({ key, nominees });
  };

  add(
    "voice",
    take(data.topChatters.filter((u) => visible(u.userId)).map((u) => ({
      id: String(u.userId),
      label: u.name,
      userIds: [String(u.userId)],
      n: u.n,
    })))
  );

  add(
    "pair",
    take(
      data.pairs
        .filter((p) => p.aId && p.bId && visible(p.aId) && visible(p.bId))
        .map((p) => ({ id: `${p.aId}+${p.bId}`, label: `${p.a} ⇄ ${p.b}`, userIds: [p.aId, p.bId], n: p.total }))
    )
  );

  add(
    "word",
    take(
      data.newWords
        .filter((w) => visible(w.by?.userId))
        .map((w) => ({ id: `w:${w.word}`, label: w.word, userIds: [], n: w.n, by: w.by ? w.by.name : null }))
    )
  );

  add("emote", take((data.emotes.top || []).map((e) => ({ id: `e:${e.word}`, label: e.word, userIds: [], n: e.n }))));

  add(
    "opener",
    take(
      Object.entries(data.firstChatters || {})
        .filter(([id]) => visible(id))
        .sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id: String(id), label: nameFor(id), userIds: [String(id)], n }))
    )
  );

  add(
    "moment",
    take(
      (data.loud || []).map((m) => ({
        id: `m:${new Date(m.at).toISOString()}`,
        label: m.chant ? m.chant.text : null,
        at: new Date(m.at),
        userIds: [],
        n: m.n,
        category: m.category || null,
      }))
    )
  );

  return ballot;
}

// A vote is valid only for a nominee on the frozen ballot.
function isValidVote(ballot, key, nomineeId) {
  const award = ballot.find((a) => a.key === key);
  return Boolean(award && award.nominees.some((n) => n.id === String(nomineeId)));
}

// rows: [{ key, nomineeId, n }] -> { [key]: [{ id, votes }] } sorted, plus the winners (ties share).
// A nominee who left the public recap after the ballot froze is dropped here, so their name never
// appears among results; their votes are simply not counted.
function results(ballot, rows, { hidden = new Set() } = {}) {
  const out = {};
  for (const award of ballot) {
    const eligible = award.nominees.filter((n) => n.userIds.every((id) => !hidden.has(String(id))));
    const counted = eligible
      .map((n) => ({ id: n.id, votes: rows.find((r) => r.key === award.key && r.nomineeId === n.id)?.n || 0 }))
      .sort((a, b) => b.votes - a.votes);
    const top = counted.length ? counted[0].votes : 0;
    out[award.key] = {
      tally: counted,
      winners: top > 0 ? counted.filter((c) => c.votes === top).map((c) => c.id) : [],
      total: counted.reduce((s, c) => s + c.votes, 0),
    };
  }
  return out;
}

module.exports = {
  MIN_VOTER_MESSAGES,
  NOMINEES_PER_AWARD,
  AWARDS,
  awardsWindow,
  phaseOf,
  buildBallot,
  isValidVote,
  results,
};
