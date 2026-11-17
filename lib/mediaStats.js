// The numbers behind the media charts (views/mediaStats.ejs, and the viewers' breakdown on a card's
// page): how often each mark 1-10 was given, and how a section's cards split by type, state and
// genre. Pure functions over rows the repos already return, so they are tested without Mongo.
const MARKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

// counts: {mark: count} or Map. -> {bars: [{mark, count, share}] for every mark 1-10, total,
// average (one decimal, null with no marks), peak (the largest count, for the bars' scale)}.
function breakdown(counts) {
  const get = (m) => Number((counts instanceof Map ? counts.get(m) : counts && counts[m]) || 0);
  const total = MARKS.reduce((n, m) => n + get(m), 0);
  const sum = MARKS.reduce((n, m) => n + m * get(m), 0);
  return {
    bars: MARKS.map((mark) => ({ mark, count: get(mark), share: pct(get(mark), total) })),
    total,
    average: total ? Math.round((sum / total) * 10) / 10 : null,
    peak: Math.max(0, ...MARKS.map(get)),
  };
}

// The streamer's marks across a section's cards (ratings.streamer, 1-10 or absent).
function streamerBreakdown(rows) {
  const counts = new Map();
  for (const row of rows) {
    const v = row.ratings?.streamer;
    if (Number.isInteger(v) && v >= 1 && v <= 10) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return breakdown(counts);
}

// Cards split by one field, in a fixed order (so a colour always means the same value); empty
// parts are dropped, cards without the field are not counted. -> {parts: [{key, count, share}], total}
function splitBy(rows, field, order) {
  const counts = new Map(order.map((k) => [k, 0]));
  for (const row of rows) {
    const k = row[field];
    if (counts.has(k)) counts.set(k, counts.get(k) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { parts: order.filter((k) => counts.get(k) > 0).map((key) => ({ key, count: counts.get(key), share: pct(counts.get(key), total) })), total };
}

// The most common genres (info.genres), most common first, the tail folded into one "other" count.
// share = the part of the CARDS that carry the genre (a card has several), so shares do not add up
// to 100 - the chart is a list of bars, not a whole split into parts.
function topGenres(rows, limit = 8) {
  const counts = new Map();
  let withGenres = 0;
  for (const row of rows) {
    const genres = row.info?.genres || [];
    if (genres.length) withGenres++;
    for (const g of new Set(genres)) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    items: sorted.slice(0, limit).map(([name, count]) => ({ name, count, share: pct(count, withGenres) })),
    more: Math.max(0, sorted.length - limit),
    withGenres,
    peak: sorted.length ? sorted[0][1] : 0,
  };
}

module.exports = { MARKS, breakdown, streamerBreakdown, splitBy, topGenres };
