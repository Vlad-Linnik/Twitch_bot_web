const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const statsRepo = require("../db/statsRepo");
const modsRepo = require("../db/modsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { getEmoteImageMap } = require("../twitch/emoteImages");
const { requireLevel } = require("../middleware/permissions");

const router = express.Router();

const TOP_CHATTERS = 5;
const EMOTE_CLOUD_SIZE = 40;

// The old single page split into two sub-pages; the bare URL stays alive as an entry point.
router.get("/:channel/statistics", requireLevel(2), (req, res) => {
  res.redirect(`/${req.params.channel}/statistics/chat`);
});

router.get("/:channel/statistics/chat", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const [totals, leaderboard, topEmotes, config] = await Promise.all([
      statsRepo.getChannelTotals(channel.channelLogin),
      statsRepo.getLeaderboard(channel.channelLogin, TOP_CHATTERS),
      statsRepo.getTopEmotes(channel.channelLogin, EMOTE_CLOUD_SIZE),
      channelConfigRepo.getConfig(channel.channelLogin),
    ]);

    // Twitch chat color per top chatter - 5 lookups against the local profile cache (each one
    // only hits Helix when its entry is missing/stale). Fail-soft: no color, no problem.
    const profiles = await Promise.all(
      leaderboard.map((u) => profileCacheRepo.getOrFetchProfile(u.userId).catch(() => null))
    );
    const topChatters = leaderboard.map((u, i) => ({ ...u, color: profiles[i]?.chatColor ?? null }));

    // Join emote usage counts (text names, from WordLifetimeStats) to real images from the
    // channel's 7TV set + Twitch's global emotes. An emote that resolves to no image (e.g.
    // removed from the set since it was counted) keeps its text form in the cloud.
    const imageMap = await getEmoteImageMap(config.sevenTv?.emoteSetUrl);
    const maxCount = topEmotes[0]?.count || 1;
    const emoteCloud = topEmotes.map((e) => ({
      word: e.word,
      count: e.count,
      imageUrl: imageMap.get(e.word) ?? null,
      // sqrt scale so mid-list emotes stay legible instead of the leader dwarfing everything
      size: Math.round(24 + Math.sqrt(e.count / maxCount) * 40),
    }));

    res.render("statisticsChat", { channel, totals, topChatters, emoteCloud, tab: "chat" });
  } catch (err) {
    next(err);
  }
});

router.get("/:channel/statistics/mod", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const [modActions, modSummary, modsListDoc] = await Promise.all([
      statsRepo.getRecentModActions(channel.channelLogin),
      statsRepo.getModeratorSummary(channel.channelId),
      modsRepo.getModerators(channel.channelId),
    ]);

    // Moderators registered in ModsList but with no ModeratorStatistics rows yet - shown dimmed
    // behind the "show moderators with no data" toggle.
    const withData = new Set(modSummary.map((m) => String(m.userId)));
    const inactiveIds = (modsListDoc?.moderators || []).filter((id) => !withData.has(String(id)));

    // One batch name lookup covers both the inactive mods and the action log's raw ids.
    const nameMap = await statsRepo.getUserNames([
      ...inactiveIds,
      ...modActions.flatMap((a) => [a.modID, a.userId]),
    ]);

    const inactiveMods = inactiveIds.map((id) => ({ userId: id, userName: nameMap.get(String(id)) || id }));
    const moderators = modSummary.map((m) => ({ ...m, userName: m.userName || m.userId }));
    const actions = modActions.map((a) => ({
      ...a,
      modName: nameMap.get(String(a.modID)) || a.modID,
      targetName: nameMap.get(String(a.userId)) || a.userId,
    }));

    res.render("statisticsMod", { channel, moderators, inactiveMods, actions, tab: "mod" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
