// /<channel>/statistics/{chat,mod} - the channel's analytics pages, plus the JSON endpoints
// their period toggles and the Universal Log Search fetch against.
//
// Gating split: the CHAT page is public (it is the channel's shop window - the home page links
// straight here), while the MOD page and the log search stay requireLevel(2). The Chat/Moderators
// tab bar is only rendered for visitors who can actually open the mod page (canModerate).
//
// The old bare /<channel> dashboard merged into the chat page; routes/channelRedirect.js keeps
// that URL alive as a redirect.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const statsRepo = require("../db/statsRepo");
const modsRepo = require("../db/modsRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const wordStatsRepo = require("../db/wordStatsRepo");
const userStatsRepo = require("../db/userStatsRepo");
const searchRepo = require("../db/searchRepo");
const streamSessionsRepo = require("../db/streamSessionsRepo");
const { withEmoteImages } = require("../twitch/emoteImages");
const { requireLevel, computePermission } = require("../middleware/permissions");
const { statsReadLimiter, searchLimiter } = require("../middleware/rateLimiters");
const limits = require("../config/statsLimits");
const { isKnownBotName } = require("../config/knownBots");

const router = express.Router();

const TOP_CHATTERS = 10;
const TOP_MENTIONS = 10;
const MOD_ACTIONS_PER_PAGE = 25;

// Stream race (public/js/stream-race.js) - how many names each of the two boards contributes to
// the pool the client draws its five racers from, and the fewest racers worth starting a race
// with. A two-horse race still reads as a race; demanding a full five would leave the button
// permanently absent on any channel quieter than this one.
const RACE_POOL_PER_BOARD = 10;
const RACE_MIN_PARTICIPANTS = 2;

// Compact duration for the mod-actions table (replaces the old free-text reason column):
// the two most significant units of d/h/m/s, e.g. "1h 30m". Language-neutral on purpose -
// unit letters read the same in both locales, so no per-locale formatting here.
function formatDuration(ms) {
  let seconds = Math.round(ms / 1000);
  const parts = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    const value = Math.floor(seconds / size);
    if (value > 0 || (unit === "s" && parts.length === 0)) parts.push(`${value}${unit}`);
    seconds %= size;
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

// Flags each row with isMe, and - if the visitor is logged in but not already among them -
// resolves their real standing as a separate row. Same "top N + your own row below it" shape
// as the on-site games' leaderboards (routes/games.js's buildLeaderboard, db/gameScoresRepo.js's
// getUserBestAndRank); statsRepo.getUserRank is that function's Top-Chatters counterpart.
async function withMyChatterRow(rows, channelLogin, userId, period) {
  const flagged = rows.map((row) => ({ ...row, isMe: userId != null && String(row.userId) === String(userId) }));
  if (!userId || flagged.some((row) => row.isMe)) return { rows: flagged, myRow: null };

  const me = await statsRepo.getUserRank(channelLogin, userId, period);
  if (!me) return { rows: flagged, myRow: null };

  const profile = await profileCacheRepo.getOrFetchProfile(me.userId).catch(() => null);
  return {
    rows: flagged,
    myRow: { ...me, color: profile?.chatColor ?? null, avatarUrl: profile?.avatarUrl ?? null },
  };
}

// Avatar + chat color for a leaderboard row, in ONE batched profile read (getOrFetchProfiles:
// one $in against the cache, one Helix call for whatever is stale) rather than a lookup per row.
// Fail-soft throughout: a row with no id (a mentioned login that resolves to no identity) or an
// unresolvable profile keeps its place and renders as a monogram, because a board with a hole in
// it is worse than a board with a missing picture.
async function withRowProfiles(rows) {
  const ids = rows.map((row) => row.userId).filter(Boolean);
  const profiles = ids.length ? await profileCacheRepo.getOrFetchProfiles(ids).catch(() => new Map()) : new Map();
  return rows.map((row) => {
    const profile = row.userId ? profiles.get(String(row.userId)) : null;
    return { ...row, color: profile?.chatColor ?? null, avatarUrl: profile?.avatarUrl ?? null };
  });
}

/**
 * Racers for the stream race on /<channel>/statistics/chat.
 *
 * Today's top chatters UNIONED with today's most-mentioned people, rather than either board on
 * its own: the race is a bit of channel theatre, and drawing only from message counts would run
 * the same five loudest regulars every time. Someone the channel talks ABOUT earns a lane even
 * if they never type.
 *
 * "Today" is `day`, which on this site means the bucket from local NOON (config/statsLimits.js's
 * periodStart, mirroring the bot's dayBucket), not a rolling 24h window - the same "today" every
 * other board on this page shows.
 *
 * Deduped on userId where the identity index resolved one and on the lowercased login otherwise,
 * because getChannelTopMentions legitimately returns `userId: null` for a mentioned login that
 * has never typed here. Those rows keep their lane and race as a monogram.
 *
 * Only ever called for permission <= 1 - an ordinary visitor's page load must not pay for two
 * aggregations feeding a button they will never be shown.
 */
async function buildRacePool(channelLogin) {
  const [chatters, mentionBoard] = await Promise.all([
    statsRepo.getTopChatters(channelLogin, "day", RACE_POOL_PER_BOARD),
    userStatsRepo.getChannelTopMentions(channelLogin, "day", RACE_POOL_PER_BOARD),
  ]);

  const byKey = new Map();
  for (const row of [...chatters, ...mentionBoard.mentions]) {
    if (!row.userName) continue;
    const key = row.userId ? `id:${row.userId}` : `login:${String(row.userName).toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { userId: row.userId ?? null, userName: row.userName });
  }
  if (byKey.size === 0) return [];

  const withProfiles = await withRowProfiles([...byKey.values()]);
  // Only what a racer needs to be drawn - no counts or ranks, since the race deliberately keeps
  // no standings of its own.
  return withProfiles.map((row) => ({
    userName: row.userName,
    avatarUrl: row.avatarUrl,
    color: row.color,
  }));
}

// Same rationale as routes/userDashboard.js: requireLevel() renders an HTML error page, which is
// useless inside a fetch(). Same tier semantics, JSON body.
function requireLevelJson(maxLevel) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.userId ?? null;
      const level = await computePermission(userId, req.params.channel);
      req.permissionLevel = level;
      if (level > maxLevel) {
        return res.status(userId ? 403 : 401).json({ error: userId ? "forbidden" : "unauthenticated" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// --- Mod-action log filters --------------------------------------------------------------
// Shared by the page render (bookmarks / first load / no-JS) and mod-actions.json (the
// client's in-place pagination + filtering). Comma-separated multi-value params, the same
// idiom the log search uses for its `users` param.
const MOD_ACTION_TYPES = ["ban", "timeout", "delete", "warn"];
const MOD_FILTER_MAX_IDS = 50;

// Action-type -> Tailwind text color, ordered by restriction severity (warn = least severe,
// nothing restricted; ban = most severe, permanent) so the recent-actions table communicates
// severity by color at a glance without a legend.
const ACTION_COLORS = {
  warn: "text-emerald-400",
  delete: "text-sky-400",
  timeout: "text-amber-400",
  ban: "text-red-400",
};

function parseModActionFilters(query) {
  const csv = (value) => (typeof value === "string" && value ? value.split(",") : []);
  const idList = (value) =>
    [...new Set(csv(value).filter((id) => /^\d+$/.test(id)))].slice(0, MOD_FILTER_MAX_IDS);

  const actions = [...new Set(csv(query.actions).filter((a) => MOD_ACTION_TYPES.includes(a)))];
  const modIds = idList(query.mods);
  // Include wins over exclude - the UI's include/exclude radio makes both-at-once impossible,
  // this is just the server holding the same line for hand-built URLs.
  const excludeModIds = modIds.length > 0 ? [] : idList(query.excludeMods);
  return { actions, modIds, excludeModIds };
}

// One batched UserIdentities lookup + one batched profile fetch for a set of ids, returning
// the same resolve() the mod page always used: UserIdentities name -> Helix display name ->
// the raw id; color = Twitch chat color, fail-soft.
async function buildNameResolver(ids) {
  const [nameMap, profiles] = await Promise.all([
    statsRepo.getUserNames(ids),
    profileCacheRepo.getOrFetchProfiles(ids).catch(() => new Map()),
  ]);
  return (id) => {
    const key = String(id);
    const profile = profiles.get(key);
    return {
      userName: nameMap.get(key) || profile?.displayName || key,
      color: profile?.chatColor ?? null,
    };
  };
}

// Raw ModeratorActionLogs docs -> the display rows both the EJS table and the JSON endpoint
// serve. Duration replaces the old reason column: the actual restriction for timeouts,
// "permanent" for bans, nothing for delete/warn (they don't restrict). The reason still rides
// along as a hover title; TTA/id feed the target-hover context popup.
function shapeActionRows(modActions, resolve, t) {
  return modActions.map((a) => {
    const mod = resolve(a.modID);
    const target = resolve(a.userId);
    const durationLabel =
      a.action === "ban"
        ? t("statistics.durationPermanent")
        : a.action === "timeout" && a.durationMs != null
          ? formatDuration(a.durationMs)
          : null;
    return {
      ...a,
      id: String(a._id),
      modName: mod.userName,
      modColor: mod.color,
      targetName: target.userName,
      targetColor: target.color,
      durationLabel,
      actionColorClass: ACTION_COLORS[a.action] || "text-neutral-200",
    };
  });
}

// The old single page split into two sub-pages; the bare URL stays alive as an entry point.
router.get("/:channel/statistics", (req, res) => {
  res.redirect(`/${encodeURIComponent(req.params.channel)}/statistics/chat`);
});

router.get("/:channel/statistics/chat", async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const period = limits.resolvePeriod(req.query.period, { max: limits.MAX_CLOUD_PERIOD });

    const [totals, leaderboard, mentionBoard, wordCloud, emoteCloud, trackedEmoteCount, broadcaster, permission, sessions] =
      await Promise.all([
        statsRepo.getChannelTotals(channel.channelLogin),
        statsRepo.getLeaderboard(channel.channelLogin, TOP_CHATTERS),
        // All-time on first paint, like Top Chatters next to it - the toggle re-fetches via
        // stats.json?component=mentions.
        userStatsRepo.getChannelTopMentions(channel.channelLogin, "all", TOP_MENTIONS),
        wordStatsRepo.getChannelWordCloud(channel.channelLogin, period),
        wordStatsRepo.getChannelEmoteCloud(channel.channelLogin, period, limits.EMOTE_CLOUD_SIZE),
        wordStatsRepo.getTrackedEmoteCount(channel.channelLogin),
        // The streamer's own avatar + chat color for the page header. Fail-soft: the header
        // falls back to a monogram and the default text color.
        profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
        computePermission(req.user?.userId ?? null, channel.channelLogin),
        streamSessionsRepo.listSessions(channel.channelId),
      ]);

    // The stream-stats chart's first paint mirrors every other component on this page: the
    // server renders the DEFAULT (newest session) so there's no flash of empty state, and the
    // client only re-fetches (stream-stats.json) when the visitor picks a different session.
    const streamChart = sessions.length
      ? await streamSessionsRepo.getSessionChartData(channel, sessions[0])
      : null;
    // Sent to the client as plain {id, startedAt, endedAt} - stream-chart.js builds the session
    // picker (grouped by LOCAL calendar date) and every axis label from these in the visitor's
    // own timezone; nothing here is formatted server-side.
    const sessionList = sessions.map((s) => ({
      id: String(s._id),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));

    const { rows: topChatters, myRow: topChattersMyRow } = await withMyChatterRow(
      await withRowProfiles(leaderboard),
      channel.channelLogin,
      req.user?.userId,
      "all"
    );

    // The race needs BOTH a track and runners, and the button is either there and works or is not
    // rendered at all - there is no disabled state and no "not enough participants" message. So
    // the pool is resolved here, server-side, before the page is built. Owner/admin only, both
    // because that is who the feature is for and because it keeps the two extra aggregations off
    // every public page load.
    const racePool = permission <= 1 ? await buildRacePool(channel.channelLogin) : [];
    const canRace = sessions.length > 0 && racePool.length >= RACE_MIN_PARTICIPANTS;

    const emotes = await withEmoteImages(channel.channelLogin, emoteCloud.emotes);
    const topMentions = await withRowProfiles(mentionBoard.mentions);

    res.render("statisticsChat", {
      channel,
      broadcaster,
      totals,
      topChatters,
      topChattersMyRow,
      // The server always renders the all-time board (getLeaderboard IS period=all); the toggle
      // starts there and only a change re-fetches via stats.json?component=topchatters.
      topChattersPeriod: "all",
      topMentions,
      topMentionsPeriod: "all",
      trackedEmoteCount,
      period,
      periods: limits.PERIODS,
      wordCloud,
      emoteCloud: { period: emoteCloud.period, emotes },
      canModerate: permission <= 2,
      tab: "chat",
      sessions: sessionList,
      streamChart,
      canRace,
      // Inlined only when the button exists, so the markup never carries a pool nobody can use.
      racePool: canRace ? racePool : [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:channel/statistics/mod", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    // Period narrows the ModeratorStatistics roll-up. Defaults to "all" (the page's historical
    // behavior) rather than resolvePeriod's own default; the toggle navigates with ?period=,
    // full page reload - the table's markup (sort data-attrs, pentagon hookup) is too rich to
    // duplicate as a client-side template for a page this rarely visited.
    const period = req.query.period ? limits.resolvePeriod(req.query.period) : "all";
    const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    // The server render honors the same filter params the JSON endpoint takes, so a filtered
    // URL survives refresh/bookmarks and works without JS.
    const filters = parseModActionFilters(req.query);

    const [
      { actions: modActions, totalPages, page },
      rawSummary,
      modsListDoc,
      broadcaster,
      actionModIds,
    ] = await Promise.all([
      statsRepo.getRecentModActions(channel.channelLogin, {
        page: requestedPage,
        limit: MOD_ACTIONS_PER_PAGE,
        ...filters,
      }),
      statsRepo.getModeratorSummary(channel.channelId, period),
      modsRepo.getModerators(channel.channelId),
      profileCacheRepo.getOrFetchProfile(channel.channelId).catch(() => null),
      // The moderator filter's option list: everyone who ever acted, not just the current
      // ModsList - options built from the rendered page's 25 rows (the old way) made
      // cross-page filtering impossible.
      statsRepo.getModActionModIds(channel.channelLogin),
    ]);

    // A summary row that aggregates to all zeros is "no data" as far as the viewer is
    // concerned - it belongs behind the toggle with the ModsList-only mods, not in the table
    // proper. The bot stopped writing all-zero daily rows (and cleanup deleted the old ones),
    // so this partition is a safety net for anything that slips through (e.g. prod data
    // before its cleanup runs).
    const modSummary = rawSummary.filter(
      (m) => m.chatActivity !== 0 || m.streamPresence !== 0 || m.moderationActivity !== 0
    );
    const zeroSummaryIds = rawSummary
      .filter((m) => !modSummary.includes(m))
      .map((m) => m.userId);

    // Moderators registered in ModsList but with no ModeratorStatistics rows in the selected
    // period - shown dimmed behind the "show moderators with no data" toggle. The channel owner
    // is never in ModsList (Twitch's channel.moderate never grants the broadcaster "mod" status),
    // so they're unioned in here explicitly - they still moderate their own channel and should
    // always appear, dimmed until the bot's next activity cycle gives them a real summary row.
    const withData = new Set(modSummary.map((m) => String(m.userId)));
    const inactiveIds = [
      ...(modsListDoc?.moderators || []),
      String(channel.channelId),
      ...zeroSummaryIds,
    ].filter((id, i, arr) => !withData.has(String(id)) && arr.indexOf(id) === i);

    // The moderator filter's options: ModsList ∪ everyone in the action log's history.
    const modOptionIds = [
      ...new Set([...(modsListDoc?.moderators || []).map(String), ...actionModIds.map(String)]),
    ];

    // Every id the page renders: the summary rows, the inactive mods, both nick columns of
    // the action log, and the filter options. One batch UserIdentities lookup + one batched
    // profile fetch (names, chat colors) - getOrFetchProfiles makes at most one Helix
    // round-trip pair for the misses.
    const allIds = [
      ...modSummary.map((m) => m.userId),
      ...inactiveIds,
      ...modActions.flatMap((a) => [a.modID, a.userId]),
      ...modOptionIds,
    ];
    // Name precedence: UserIdentities (what the rest of the site shows) -> Helix display name
    // (fixes the raw numeric IDs that used to render for users the bot never saw chat from) ->
    // the id itself as a last resort. Color is the user's Twitch chat color, fail-soft.
    const resolve = await buildNameResolver(allIds);

    // Bot accounts (config/knownBots.js) are not people - they never belong in the moderator
    // statistics table, active or dimmed. Their recent ACTIONS stay visible below on purpose.
    const inactiveMods = inactiveIds
      .map((id) => ({ userId: id, ...resolve(id) }))
      .filter((m) => !isKnownBotName(m.userName));
    const moderators = modSummary
      .map((m) => {
        const { userName, color } = resolve(m.userId);
        return { ...m, userName: m.userName || userName, color };
      })
      .filter((m) => !isKnownBotName(m.userName));
    const actions = shapeActionRows(modActions, resolve, res.locals.t);

    // Sorted by display name so the dropdown reads like a roster, not an id dump.
    const modOptions = modOptionIds
      .map((id) => ({ id, name: resolve(id).userName }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.render("statisticsMod", {
      channel,
      broadcaster,
      moderators,
      inactiveMods,
      actions,
      page,
      totalPages,
      period,
      periods: limits.PERIODS,
      actionTypes: MOD_ACTION_TYPES,
      modOptions,
      filterState: filters,
      tab: "mod",
    });
  } catch (err) {
    next(err);
  }
});

// The mod-actions table's in-place pagination + filtering. Same tier gate as the page
// (requireLevel(2) there, JSON body here), same filter parsing, same row shape - the client
// rebuilds exactly what the server rendered.
router.get(
  "/:channel/mod-actions.json",
  requireLevelJson(2),
  statsReadLimiter,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).json({ error: "unknown_channel" });

      const filters = parseModActionFilters(req.query);
      const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);

      const { actions: modActions, total, totalPages, page } = await statsRepo.getRecentModActions(
        channel.channelLogin,
        { page: requestedPage, limit: MOD_ACTIONS_PER_PAGE, ...filters }
      );

      const resolve = await buildNameResolver(modActions.flatMap((a) => [a.modID, a.userId]));
      const actions = shapeActionRows(modActions, resolve, res.locals.t);

      res.json({ actions, total, totalPages, page });
    } catch (err) {
      next(err);
    }
  }
);

// --- Period switches (JSON) ---------------------------------------------------------------

router.get("/:channel/stats.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    // The channel-wide clouds aggregate across every chatter, so they get the tightest period cap
    // in the codebase - see config/statsLimits.js for the measurements behind it.
    const period = limits.resolvePeriod(req.query.period, { max: limits.MAX_CLOUD_PERIOD });

    switch (req.query.component) {
      case "wordcloud":
        return res.json(await wordStatsRepo.getChannelWordCloud(channel.channelLogin, period));
      case "emotes": {
        const cloud = await wordStatsRepo.getChannelEmoteCloud(
          channel.channelLogin,
          period,
          limits.EMOTE_CLOUD_SIZE
        );
        const emotes = await withEmoteImages(channel.channelLogin, cloud.emotes);
        return res.json({ period: cloud.period, emotes });
      }
      case "topchatters": {
        const chatters = await statsRepo.getTopChatters(channel.channelLogin, period, TOP_CHATTERS);
        // Same avatar/color join the initial page render does - cache-backed, fail-soft.
        const decorated = await withRowProfiles(chatters);
        const { rows, myRow } = await withMyChatterRow(decorated, channel.channelLogin, req.user?.userId, period);
        return res.json({ period, chatters: rows, myRow });
      }
      case "mentions": {
        // Not capped to MAX_CLOUD_PERIOD: this is not a cloud. UserMentionStats is ~84k rows
        // against ChatWordStats' ~2.2M, and its widest range measures in single-digit ms.
        const mentionPeriod = limits.resolvePeriod(req.query.period);
        const board = await userStatsRepo.getChannelTopMentions(channel.channelLogin, mentionPeriod, TOP_MENTIONS);
        return res.json({ period: board.period, mentions: await withRowProfiles(board.mentions) });
      }
      default:
        return res.status(400).json({ error: "unknown_component" });
    }
  } catch (err) {
    next(err);
  }
});

// The stream-stats chart's session picker - fetched only when the visitor picks a session other
// than the newest one (which the page already rendered server-side).
router.get("/:channel/stream-stats.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    const session = await streamSessionsRepo.getSessionById(channel.channelId, req.query.session);
    if (!session) return res.status(404).json({ error: "unknown_session" });

    res.json(await streamSessionsRepo.getSessionChartData(channel, session));
  } catch (err) {
    next(err);
  }
});

// --- Find-a-user typeahead --------------------------------------------------------------
// Public, like the page itself - the search box exists precisely so an anonymous visitor isn't
// limited to Top Chatters' top 10. statsReadLimiter (not searchLimiter) because this is a bounded
// index lookup, not the log search's per-message scan.
router.get("/:channel/user-search.json", statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    const users = await userStatsRepo.searchUsernames(channel.channelLogin, req.query.q);
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// --- Mod-action context (moderator-only) ----------------------------------------------------
// The chat history behind one row of the recent-actions table: the message the target was
// actioned for + up to 5 of their previous messages. Fetched lazily on hover (mod-stats.js) -
// per-row queries against `messages` are too expensive to run eagerly for all 25 rows.
router.get("/:channel/mod-action-context.json", requireLevelJson(2), statsReadLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    const context = await statsRepo.getModActionContext(channel.channelLogin, req.query.id);
    if (!context) return res.status(404).json({ error: "unknown_action" });
    res.json(context);
  } catch (err) {
    next(err);
  }
});

// --- Universal log search (moderator-only) --------------------------------------------------

router.get("/:channel/search.json", requireLevelJson(2), searchLimiter, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).json({ error: "unknown_channel" });

    // "users" is a comma-separated list of LOGINS as typed by the moderator; the search itself
    // filters on userId, so resolve first. Naming a user here doesn't just filter the result -
    // it narrows the index range the query runs over, which is what makes fuzzy affordable. So a
    // multi-user search is CHEAPER than a channel-wide one, not more expensive.
    const typed = String(req.query.users || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const { users, unresolved } = await userStatsRepo.resolveUserIds(typed);

    const result = await searchRepo.searchLogs(channel.channelLogin, {
      term: req.query.q,
      userIds: users.map((u) => u.userId),
      period: req.query.period,
      fuzzy: req.query.fuzzy === "1",
      limit: req.query.limit,
    });

    // Report the names we could not resolve rather than silently returning fewer results - a
    // moderator who typos a username should be told, not left wondering why someone has no logs.
    res.json({ ...result, users, unresolved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
