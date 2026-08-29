// Tier-0 admin pages for the AI mention replies: the global settings, the per-channel fine
// settings that moved off the channel owner's own page, and the five tables the feature keeps -
// filter, answer cache, channel memory, call journal, ignore list.
//
// WHY THIS IS ADMIN-ONLY. The channel owner keeps what is theirs: the banned-word list, the reply
// phrases, and the on/off switches for both. Everything here either spends the project's API
// budget or decides who gets timed out, which makes it a tier-0 decision - and the tone field is
// part of the prompt, so handing it to a channel owner would hand them a lever into what the bot
// says under our key.
const express = require("express");
const { requireLevel } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const aiConfigRepo = require("../db/aiConfigRepo");
const aiFilterRepo = require("../db/aiFilterRepo");
const aiCacheRepo = require("../db/aiCacheRepo");
const aiLogRepo = require("../db/aiLogRepo");
const aiIgnoreRepo = require("../db/aiIgnoreRepo");
const aiMemoryRepo = require("../db/aiMemoryRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { diffConfig } = require("../lib/settingsDiff");
const { parseSubmittedConfig } = require("../lib/settingsValidation");
const aiValidation = require("../lib/aiSettingsValidation");

const router = express.Router();
const requireAdmin = requireLevel(0);

const LOG_PAGE_SIZE = 100;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// --- global settings ----------------------------------------------------------------------------

router.get("/admin/ai", requireAdmin, async (req, res, next) => {
  try {
    const [config, today, filterCount, ignoredCount, tally] = await Promise.all([
      aiConfigRepo.getConfig(),
      aiLogRepo.spendSince(startOfToday()),
      aiFilterRepo.count(),
      aiIgnoreRepo.count(),
      aiLogRepo.reviewTally(),
    ]);
    res.render("adminAi", {
      tab: "ai",
      aiTab: "settings",
      config,
      today,
      filterCount,
      ignoredCount,
      tally,
      validation: aiValidation,
      // Not a knob: the key lives in the BOT's .env, so the site can only report whether its own
      // copy is present. A bot without the key falls back to the scripted replies.
      keyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const existing = await aiConfigRepo.getConfig();
    const parsed = aiValidation.parseGlobalConfig(req.body, existing);
    await aiConfigRepo.saveConfig(parsed, req.user.userId);

    // The journal's TTL is a stored index option, not a query filter, so a changed retention only
    // takes effect if the index itself is altered - see aiLogRepo.setRetentionDays.
    if (parsed.memoryTtlDays !== existing.memoryTtlDays) {
      await aiLogRepo.setRetentionDays(parsed.memoryTtlDays);
    }

    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.config.update",
      target: "global",
      details: {
        enabled: parsed.enabled,
        model: parsed.model,
        dailyRequestLimit: parsed.dailyRequestLimit,
        punishMode: parsed.punishMode,
      },
    });
    res.redirect("/admin/ai?saved=1");
  } catch (err) {
    next(err);
  }
});

// --- per-channel --------------------------------------------------------------------------------

router.get("/admin/ai/channels", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const configs = await Promise.all(channels.map((c) => channelConfigRepo.getConfig(c.channelLogin)));
    const rows = channels.map((c, i) => ({
      channelLogin: c.channelLogin,
      enabled: Boolean(c.enabled),
      ai: configs[i].ai || { enabled: false, tone: "", cheatsheet: "" },
    }));
    res.render("adminAiChannels", { tab: "ai", aiTab: "channels", rows });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/ai/channels/:login", requireAdmin, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.login);
    if (!channel) return res.status(404).render("errors/404");
    const config = await channelConfigRepo.getConfig(req.params.login);
    res.render("adminAiChannel", {
      tab: "ai",
      aiTab: "channels",
      channel,
      config,
      validation: aiValidation,
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/ai/channels/:login",
  settingsWriteLimiter,
  requireAdmin,
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.login);
      if (!channel) return res.status(404).render("errors/404");

      const existing = await channelConfigRepo.getConfig(req.params.login);

      // Two writes, on purpose. The cooldowns are ordinary channel config and go through the same
      // parser every other settings page uses; the `ai` block goes through its own writer, which
      // touches nothing else - that separation is what stops an owner's save and an admin's save
      // from overwriting each other.
      const parsed = parseSubmittedConfig(req.body, existing);
      await channelConfigRepo.saveConfig(req.params.login, parsed, req.user.userId);

      const ai = aiValidation.parseChannelAi(req.body);
      await channelConfigRepo.saveAiConfig(req.params.login, ai, req.user.userId);

      // Both halves land in the channel's own change log rather than only in the admin log: the
      // owner cannot edit these any more, but they can still see that they changed and when.
      const changes = diffConfig(existing, parsed);
      for (const field of ["enabled", "tone", "cheatsheet"]) {
        const before = existing.ai ? existing.ai[field] : null;
        if (before !== ai[field]) {
          changes.push({ field: `ai.${field}`, before: before ?? null, after: ai[field] });
        }
      }
      await Promise.all(
        changes.map((c) =>
          settingsChangeLogRepo.logChange({
            channelLogin: req.params.login,
            user: req.user,
            category: "settings",
            action: "update",
            target: c.field,
            before: c.before,
            after: c.after,
          })
        )
      );

      res.redirect(`/admin/ai/channels/${req.params.login}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

// --- filter -------------------------------------------------------------------------------------

router.get("/admin/ai/filter", requireAdmin, async (req, res, next) => {
  try {
    const entries = await aiFilterRepo.list();
    res.render("adminAiFilter", { tab: "ai", aiTab: "filter", entries });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/filter", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const key = await aiFilterRepo.upsert({ text: req.body.text, answer: req.body.answer, source: "admin" });
    if (key) {
      await adminActionLogsRepo.logAction({ admin: req.user, action: "ai.filter.upsert", target: key });
    }
    res.redirect("/admin/ai/filter");
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/filter/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    await aiFilterRepo.remove(req.body.text);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.filter.delete",
      target: String(req.body.text || ""),
    });
    res.redirect("/admin/ai/filter");
  } catch (err) {
    next(err);
  }
});

// --- answer cache -------------------------------------------------------------------------------

router.get("/admin/ai/cache", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (channels[0] && channels[0].channelLogin) || null;
    const entries = selected ? await aiCacheRepo.listForChannel(selected) : [];
    res.render("adminAiCache", { tab: "ai", aiTab: "cache", channels, selected, entries });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/cache/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    await aiCacheRepo.remove(req.body.channel, req.body.text);
    res.redirect(`/admin/ai/cache?channel=${encodeURIComponent(req.body.channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/cache/clear", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const removed = await aiCacheRepo.clearChannel(req.body.channel);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.cache.clear",
      target: String(req.body.channel || ""),
      details: { removed },
    });
    res.redirect(`/admin/ai/cache?channel=${encodeURIComponent(req.body.channel)}`);
  } catch (err) {
    next(err);
  }
});

// --- channel memory -----------------------------------------------------------------------------

// The facts the bot wrote for itself, curated the same way the answer cache is: one channel at a
// time, one row at a time. Adding by hand is here too - the memory is one list whichever side
// filled a row, and a fact typed here is simply a row the bot's rotation will never evict.
router.get("/admin/ai/memory", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (channels[0] && channels[0].channelLogin) || null;
    const [entries, config] = await Promise.all([
      selected ? aiMemoryRepo.listForChannel(selected) : Promise.resolve([]),
      aiConfigRepo.getConfig(),
    ]);
    res.render("adminAiMemory", {
      tab: "ai",
      aiTab: "memory",
      channels,
      selected,
      entries,
      config,
      maxFactLen: aiMemoryRepo.MAX_FACT_LEN,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/memory", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const key = await aiMemoryRepo.addManual(channel, req.body.fact, req.user.login || req.user.userId);
    if (key) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.memory.add",
        target: channel,
        details: { fact: String(req.body.fact || "").slice(0, aiMemoryRepo.MAX_FACT_LEN) },
      });
    }
    res.redirect(`/admin/ai/memory?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/memory/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    await aiMemoryRepo.remove(req.body.channel, req.body.key);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.memory.delete",
      target: String(req.body.channel || ""),
      details: { key: String(req.body.key || "") },
    });
    res.redirect(`/admin/ai/memory?channel=${encodeURIComponent(req.body.channel || "")}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/memory/clear", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const removed = await aiMemoryRepo.clearChannel(req.body.channel);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.memory.clear",
      target: String(req.body.channel || ""),
      details: { removed },
    });
    res.redirect(`/admin/ai/memory?channel=${encodeURIComponent(req.body.channel || "")}`);
  } catch (err) {
    next(err);
  }
});

// --- journal ------------------------------------------------------------------------------------

router.get("/admin/ai/log", requireAdmin, async (req, res, next) => {
  try {
    const [rows, today, channels] = await Promise.all([
      aiLogRepo.listRecent({ limit: LOG_PAGE_SIZE, channel: req.query.channel || null }),
      aiLogRepo.spendSince(startOfToday()),
      channelsRepo.listAll(),
    ]);
    res.render("adminAiLog", {
      tab: "ai",
      aiTab: "log",
      rows,
      today,
      channels,
      selected: req.query.channel || "",
    });
  } catch (err) {
    next(err);
  }
});

// --- punishments (the observe-mode journal) -----------------------------------------------------

router.get("/admin/ai/verdicts", requireAdmin, async (req, res, next) => {
  try {
    const [rows, tally, config] = await Promise.all([
      aiLogRepo.listRecent({ limit: LOG_PAGE_SIZE, verdict: "timeout" }),
      aiLogRepo.reviewTally(),
      aiConfigRepo.getConfig(),
    ]);
    res.render("adminAiVerdicts", { tab: "ai", aiTab: "verdicts", rows, tally, config });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/admin/ai/verdicts/:id/review",
  settingsWriteLimiter,
  requireAdmin,
  verifyToken,
  async (req, res, next) => {
    try {
      const review = req.body.review === "agree" ? "agree" : "disagree";
      await aiLogRepo.setReview(req.params.id, review);
      res.redirect("/admin/ai/verdicts");
    } catch (err) {
      next(err);
    }
  }
);

// --- ignore list --------------------------------------------------------------------------------

router.get("/admin/ai/ignored", requireAdmin, async (req, res, next) => {
  try {
    const entries = await aiIgnoreRepo.list();
    res.render("adminAiIgnored", { tab: "ai", aiTab: "ignored", entries });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/ignored/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    await aiIgnoreRepo.remove(req.body.channel, req.body.userId);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.ignored.remove",
      target: `${req.body.channel}/${req.body.userId}`,
    });
    res.redirect("/admin/ai/ignored");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
