// The moderator-statistics summary on /<channel>/statistics/mod: the per-moderator table and the
// skill pentagon it drives on row hover (mod-stats.js reads the five axes straight from each
// row's data-* attributes, so the table IS the pentagon's data).
//
// This part of the page is public; the recent-actions log below it, its filters and the
// ban-context popup are moderator-only. Building the summary here, as an explicit whitelist of
// fields, is what keeps that line on the server: a guest's render receives only what these
// functions return, so a field added to the ModeratorStatistics aggregation later (or anything
// the action log carries - chat text, reasons, the logins of the punished) cannot reach a guest
// by riding along on a spread.

// The five axes of the pentagon, plus the two columns that identify a row. Nothing else of a
// summary row is rendered, so nothing else is passed on.
const PUBLIC_ROW_FIELDS = [
  "chatActivity",
  "streamPresence",
  "reactionSpeed",
  "severity",
  "moderationActivity",
];

function hasAnyData(row) {
  return row.chatActivity !== 0 || row.streamPresence !== 0 || row.moderationActivity !== 0;
}

// rawSummary: statsRepo.getModeratorSummary rows. modsListIds: ModsList.moderators.
// resolve(id) -> { userName, color }. isBot(name) -> true for known bot accounts.
//
// A summary row that aggregates to all zeros is "no data" as far as the viewer is concerned - it
// belongs behind the "show moderators with no data" toggle with the ModsList-only mods, not in
// the table proper. The bot stopped writing all-zero daily rows, so this partition is a safety
// net for anything that slips through.
//
// The inactive list is ModsList ∪ the channel owner ∪ those zero rows, minus everyone who has
// data. The owner is never in ModsList (Twitch's channel.moderate never grants the broadcaster
// "mod" status) but moderates their own channel, so they always appear - dimmed until the bot's
// next activity cycle gives them a real summary row.
//
// Bot accounts are not people - they never belong in this table, active or dimmed. Their ACTIONS
// stay visible in the moderator-only log on purpose.
function buildModSummary({ rawSummary, modsListIds, channelId, resolve, isBot }) {
  const withDataRows = rawSummary.filter(hasAnyData);
  const zeroIds = rawSummary.filter((m) => !hasAnyData(m)).map((m) => String(m.userId));

  const withData = new Set(withDataRows.map((m) => String(m.userId)));
  const inactiveIds = [...(modsListIds || []).map(String), String(channelId), ...zeroIds].filter(
    (id, i, arr) => !withData.has(id) && arr.indexOf(id) === i
  );

  const moderators = withDataRows
    .map((m) => {
      const { userName, color } = resolve(m.userId);
      const row = { userName: m.userName || userName, color: color ?? null };
      for (const field of PUBLIC_ROW_FIELDS) row[field] = m[field] ?? null;
      // The template formats these unconditionally (toLocaleString/toFixed).
      row.chatActivity = row.chatActivity ?? 0;
      row.streamPresence = row.streamPresence ?? 0;
      row.severity = row.severity ?? 0;
      row.moderationActivity = row.moderationActivity ?? 0;
      return row;
    })
    .filter((m) => !isBot(m.userName));

  const inactiveMods = inactiveIds
    .map((id) => {
      const { userName, color } = resolve(id);
      return { userName, color: color ?? null };
    })
    .filter((m) => !isBot(m.userName));

  return { moderators, inactiveMods };
}

// Every id the summary renders, for the caller's one batched name/profile lookup.
function summaryIds({ rawSummary, modsListIds, channelId }) {
  return [...rawSummary.map((m) => m.userId), ...(modsListIds || []), channelId].map(String);
}

// The moderator-only half of the page's locals. A visitor below tier 2 gets the summary and
// nothing else: the keys are absent rather than empty, so a template branch that forgets its
// canModerate guard throws in development instead of quietly rendering an empty log to a guest.
const PRIVATE_KEYS = ["actions", "page", "totalPages", "actionTypes", "modOptions", "filterState"];

function buildModStatsPageModel({ base, summary, canModerate, privateData }) {
  const model = {
    ...base,
    moderators: summary.moderators,
    inactiveMods: summary.inactiveMods,
    canModerate: Boolean(canModerate),
  };
  if (!canModerate) return model;
  for (const key of PRIVATE_KEYS) model[key] = privateData[key];
  return model;
}

module.exports = {
  buildModSummary,
  summaryIds,
  buildModStatsPageModel,
  PUBLIC_ROW_FIELDS,
  PRIVATE_KEYS,
};
