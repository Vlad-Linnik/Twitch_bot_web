// How long each game was on a channel's stream, from the bot's StreamViewerSamples - one row per
// live channel every five minutes (TwitchBot's ActivitiTracker poll), carrying the stream's category.
// Pure: the aggregation result in, a lookup out.
//
// A sample stands for the five minutes around it, so minutes = samples x SAMPLE_MINUTES. That is an
// estimate with an error of one sample at each end of a stretch, which is the precision the card
// shows ("23 h") anyway.
const SAMPLE_MINUTES = 5;

// The bot's category comparison (TwitchBot/commands/CustomCommands.js, lib/categoryLookup.js):
// trim + lower case, nothing looser.
const categoryKey = (name) => String(name ?? "").trim().toLowerCase();

// rows: [{_id: categoryName, samples, lastSeen}] -> Map<categoryKey, {name, minutes, lastSeen}>
function buildHoursIndex(rows) {
  const index = new Map();
  for (const row of rows || []) {
    const key = categoryKey(row._id);
    if (!key) continue;
    const prev = index.get(key);
    const minutes = (prev?.minutes || 0) + (Number(row.samples) || 0) * SAMPLE_MINUTES;
    const lastSeen = !prev || new Date(row.lastSeen) > new Date(prev.lastSeen) ? row.lastSeen : prev.lastSeen;
    index.set(key, { name: prev?.name || String(row._id).trim(), minutes, lastSeen });
  }
  return index;
}

// Categories with time on stream and no card yet, most-played first - the editor's quick picks.
function playedWithoutCard(index, cards, limit = 12) {
  const carded = new Set(cards.map((c) => categoryKey(c.external?.twitchCategoryName || "")).filter(Boolean));
  return [...index.entries()]
    .filter(([key]) => !carded.has(key))
    .map(([, v]) => v)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, limit);
}

module.exports = { SAMPLE_MINUTES, categoryKey, buildHoursIndex, playedWithoutCard };
