const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const countersRepo = require("../db/countersRepo");
const modsRepo = require("../db/modsRepo");
const modPermissionOverridesRepo = require("../db/modPermissionOverridesRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { requireLevel, requireSettingsEditAccess } = require("../middleware/permissions");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter, autosaveLimiter } = require("../middleware/rateLimiters");
const { MAX_LIST_ITEMS, sanitizeWord, parseSubmittedConfig } = require("../lib/settingsValidation");
const { DURATION_PRESETS, PERMANENT, normalizeSignatureEntry, parseSignatureEntry } = require("../lib/spamSignatureValidation");
const { diffConfig } = require("../lib/settingsDiff");
const { describeChange } = require("../lib/settingsChangeDescribe");
const { getSevenTvLinkStatus } = require("../twitch/emoteImages");

const router = express.Router();

const CHANGE_LOG_PER_PAGE = 25;

// Writes one SettingsChangeLog row per changed top-level (or per-command) field - called after
// every successful channelConfigRepo.saveConfig() so "before" must be the config snapshot taken
// BEFORE that save (the main POST and the config sub-pages already fetch `existing` for
// parseSubmittedConfig; the word-list/standalone routes must snapshot it themselves first).
async function logConfigChanges(channelLogin, user, before, after) {
  const changes = diffConfig(before, after);
  await Promise.all(
    changes.map((c) =>
      settingsChangeLogRepo.logChange({
        channelLogin,
        user,
        category: "settings",
        action: "update",
        target: c.field,
        before: c.before,
        after: c.after,
      })
    )
  );
}

// Settings-type forms are saved two ways: public/js/autosave.js fetches with
// `Accept: application/json` and needs a JSON status back, while the no-JS
// fallback is the classic POST -> redirect. Same handler, two response shapes.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

function respondSaved(req, res, redirectTo) {
  if (wantsJson(req)) return res.status(200).json({ ok: true });
  res.redirect(redirectTo);
}

router.get("/:channel/settings", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const [config, customCommands, counters, sevenTvStatus] = await Promise.all([
      channelConfigRepo.getConfig(req.params.channel),
      customCommandsRepo.list(req.params.channel),
      countersRepo.list(req.params.channel),
      // emoteImages.js's getSevenTvLinkStatus is already fail-soft (a 7TV outage resolves to
      // "not linked" rather than rejecting), so no extra catch needed here.
      getSevenTvLinkStatus(channel.channelId),
    ]);
    res.render("settings", {
      channel,
      config,
      customCommandCount: customCommands.length,
      counterCount: counters.length,
      sevenTvStatus,
      saved: req.query.saved === "1",
      canManageModerators: req.permissionLevel <= 1,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings", autosaveLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const existing = await channelConfigRepo.getConfig(req.params.channel);
    const parsed = parseSubmittedConfig(req.body, existing);

    await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);
    await logConfigChanges(req.params.channel, req.user, existing, parsed);

    respondSaved(req, res, `/${req.params.channel}/settings?saved=1`);
  } catch (err) {
    next(err);
  }
});

// Command-group settings moved off the main settings page onto their own sub-pages
// (custom commands, counters) - each renders a subset of the command rows and POSTs
// back through the same parseSubmittedConfig, which carries every unrendered field
// over from the stored config (see lib/settingsValidation.js's partial-form contract).
function registerConfigSubPage(basePath, viewName, getExtras = null) {
  router.get(`/:channel${basePath}`, requireLevel(2), async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const extras = getExtras ? await getExtras(req.params.channel) : {};
      res.render(viewName, { channel, config, saved: req.query.saved === "1", ...extras });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}`, autosaveLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const existing = await channelConfigRepo.getConfig(req.params.channel);
      const parsed = parseSubmittedConfig(req.body, existing);
      await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);
      await logConfigChanges(req.params.channel, req.user, existing, parsed);

      respondSaved(req, res, `/${req.params.channel}${basePath}?saved=1`);
    } catch (err) {
      next(err);
    }
  });
}

registerConfigSubPage("/settings/custom-commands", "channelCustomCommandsSettings");
registerConfigSubPage("/settings/counters", "channelCountersSettings");

// Banned Words and Spam Signatures moved off the main settings page onto
// their own sub-pages (search + add/edit/delete instead of one big textarea
// blob) - both are just a flat string array on the config, so the add/edit/
// delete routes share this factory instead of tripling the same CRUD logic.
// targetLabel names the list in SettingsChangeLog entries (e.g. "bannedWords.words") -
// derived once per registration rather than from basePath, since the two aren't always
// the same shape as the underlying config field.
function registerWordListRoutes(basePath, viewName, getList, targetLabel) {
  router.get(`/:channel${basePath}`, requireLevel(2), async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const rawEdit = parseInt(req.query.edit, 10);
      const editIndex = Number.isInteger(rawEdit) && rawEdit >= 0 && rawEdit < words.length ? rawEdit : null;

      res.render(viewName, { channel, config, editIndex });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/add`, settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const before = [...words];
      const word = sanitizeWord(req.body.word);
      if (word && !words.includes(word) && words.length < MAX_LIST_ITEMS) {
        words.push(word);
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
        await settingsChangeLogRepo.logChange({
          channelLogin: req.params.channel, user: req.user, category: "settings",
          action: "add", target: targetLabel, before, after: [...words],
        });
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/edit`, settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const before = [...words];
      const index = parseInt(req.body.index, 10);
      const word = sanitizeWord(req.body.word);
      if (word && Number.isInteger(index) && index >= 0 && index < words.length) {
        words[index] = word;
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
        await settingsChangeLogRepo.logChange({
          channelLogin: req.params.channel, user: req.user, category: "settings",
          action: "update", target: targetLabel, before, after: [...words],
        });
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/delete`, settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const config = await channelConfigRepo.getConfig(req.params.channel);
      const words = getList(config);
      const before = [...words];
      const index = parseInt(req.body.index, 10);
      if (Number.isInteger(index) && index >= 0 && index < words.length) {
        words.splice(index, 1);
        await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
        await settingsChangeLogRepo.logChange({
          channelLogin: req.params.channel, user: req.user, category: "settings",
          action: "delete", target: targetLabel, before, after: [...words],
        });
      }
      res.redirect(`/${req.params.channel}${basePath}`);
    } catch (err) {
      next(err);
    }
  });
}

registerWordListRoutes("/settings/banned-words", "channelBannedWords", (config) => config.bannedWords.words, "bannedWords.words");

// Spam signatures: each entry needs a word PLUS an optional per-signature ban duration (falling
// back to permanent) and an optional per-signature reason (falling back to the channel's shared
// spamBanReason at ban time - see TwitchBot/commands/msgHandle.js's spam_protection). That's a
// richer shape than registerWordListRoutes' plain-string CRUD handles, so this gets its own
// routes instead of being squeezed through that factory.
router.get("/:channel/settings/spam-signatures", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const signatures = config.spamSignatures.map(normalizeSignatureEntry);
    const rawEdit = parseInt(req.query.edit, 10);
    const editIndex = Number.isInteger(rawEdit) && rawEdit >= 0 && rawEdit < signatures.length ? rawEdit : null;

    res.render("channelSpamSignatures", {
      channel, config, signatures, editIndex, error: req.query.error || null,
      durationPresets: DURATION_PRESETS, PERMANENT,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/spam-signatures/add", settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const signatures = config.spamSignatures.map(normalizeSignatureEntry);
    const before = [...signatures];
    // The quick "type to add" flow only ever submits a word (see public/js/word-list-search.js) -
    // a fresh signature starts as permanent + the shared reason, customizable afterward via edit.
    const parsed = parseSignatureEntry({ word: req.body.word, duration: "", reason: "" });
    if (parsed.ok && !signatures.some((s) => s.word === parsed.entry.word) && signatures.length < MAX_LIST_ITEMS) {
      signatures.push(parsed.entry);
      config.spamSignatures = signatures;
      await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "add", target: "spamSignatures", before, after: [...signatures],
      });
    }
    res.redirect(`/${req.params.channel}/settings/spam-signatures`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/spam-signatures/edit", settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const signatures = config.spamSignatures.map(normalizeSignatureEntry);
    const before = [...signatures];
    const index = parseInt(req.body.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= signatures.length) {
      return res.redirect(`/${req.params.channel}/settings/spam-signatures`);
    }

    const parsed = parseSignatureEntry(req.body);
    if (!parsed.ok) {
      return res.redirect(`/${req.params.channel}/settings/spam-signatures?edit=${index}&error=${parsed.error}`);
    }

    signatures[index] = parsed.entry;
    config.spamSignatures = signatures;
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
    await settingsChangeLogRepo.logChange({
      channelLogin: req.params.channel, user: req.user, category: "settings",
      action: "update", target: "spamSignatures", before, after: [...signatures],
    });
    res.redirect(`/${req.params.channel}/settings/spam-signatures`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/spam-signatures/delete", settingsWriteLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const signatures = config.spamSignatures.map(normalizeSignatureEntry);
    const before = [...signatures];
    const index = parseInt(req.body.index, 10);
    if (Number.isInteger(index) && index >= 0 && index < signatures.length) {
      signatures.splice(index, 1);
      config.spamSignatures = signatures;
      await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "delete", target: "spamSignatures", before, after: [...signatures],
      });
    }
    res.redirect(`/${req.params.channel}/settings/spam-signatures`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/banned-words/timeout-reason", autosaveLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const before = config.bannedWords.timeoutReason;
    config.bannedWords.timeoutReason = sanitizeWord(req.body.timeoutReason);
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
    if (before !== config.bannedWords.timeoutReason) {
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "update", target: "bannedWords.timeoutReason", before, after: config.bannedWords.timeoutReason,
      });
    }

    respondSaved(req, res, `/${req.params.channel}/settings/banned-words`);
  } catch (err) {
    next(err);
  }
});

// The banned-word detection feature switch (the bot's commands.insult.enabled flag). It lives
// on the Banned Words page, next to the word list it gates, not in the commands table - it has
// no chat signature and never behaved like a command.
router.post("/:channel/settings/banned-words/detection-toggle", autosaveLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const before = !!config.commands.insult?.enabled;
    config.commands.insult = { ...config.commands.insult, enabled: req.body.detectionEnabled === "on" };
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
    if (before !== config.commands.insult.enabled) {
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "update", target: "commands.insult.enabled", before, after: config.commands.insult.enabled,
      });
    }

    respondSaved(req, res, `/${req.params.channel}/settings/banned-words`);
  } catch (err) {
    next(err);
  }
});

// Ban reason shown to users caught by a spam signature - mirrors banned-words' timeout reason.
router.post("/:channel/settings/spam-signatures/reason", autosaveLimiter, requireSettingsEditAccess(), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const before = config.spamBanReason;
    config.spamBanReason = sanitizeWord(req.body.spamBanReason);
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
    if (before !== config.spamBanReason) {
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "update", target: "spamBanReason", before, after: config.spamBanReason,
      });
    }

    respondSaved(req, res, `/${req.params.channel}/settings/spam-signatures`);
  } catch (err) {
    next(err);
  }
});

// Read-only: who changed what and when (db/settingsChangeLogRepo.js). Any tier <= 2 (owner,
// admin, or moderator) can view - the moderator identity was already snapshotted at write time,
// so no extra profile lookups are needed to render it.
router.get("/:channel/settings/change-log", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const requestedPage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { entries, totalPages, page } = await settingsChangeLogRepo.listRecent(req.params.channel, {
      page: requestedPage,
      limit: CHANGE_LOG_PER_PAGE,
    });
    const described = await describeEntries(entries, res.locals.t);

    res.render("channelSettingsChangeLog", { channel, entries: described, page, totalPages });
  } catch (err) {
    next(err);
  }
});

// Resolves "moderator-permission:<id>" targets to a display name (falls back to the raw id if
// the profile can't be fetched) and attaches a describeChange() one-liner to every entry, so the
// view never has to render raw before/after JSON as the primary summary.
async function describeEntries(entries, t) {
  const moderatorIds = [
    ...new Set(
      entries
        .filter((e) => e.category === "settings" && e.target.startsWith("moderator-permission:"))
        .map((e) => e.target.slice("moderator-permission:".length))
    ),
  ];
  const moderatorNames = moderatorIds.length
    ? await profileCacheRepo
        .getOrFetchProfiles(moderatorIds)
        .then((profiles) => new Map([...profiles].map(([id, p]) => [id, p.displayName || id])))
        .catch(() => new Map())
    : new Map();

  return entries.map((e) => ({ ...e, description: describeChange(t, e, { moderatorNames }) }));
}

// Owner-only: per-moderator toggle for whether that moderator may EDIT settings/commands/
// counters (db/modPermissionOverridesRepo.js) - viewing is unaffected. requireLevel(1), not (2):
// only the owner (or admin) should get to reassign another moderator's permissions.
router.get("/:channel/settings/moderators", requireLevel(1), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const modsListDoc = await modsRepo.getModerators(channel.channelId);
    const moderatorIds = modsListDoc?.moderators || [];

    const [profiles, overrides] = await Promise.all([
      profileCacheRepo.getOrFetchProfiles(moderatorIds).catch(() => new Map()),
      modPermissionOverridesRepo.listForChannel(channel.channelId),
    ]);

    const moderators = moderatorIds.map((id) => {
      const profile = profiles.get(String(id));
      const override = overrides.get(String(id));
      return {
        userId: id,
        userName: profile?.displayName || id,
        canEditSettings: override?.canEditSettings !== false,
      };
    });

    res.render("channelModeratorPermissions", { channel, moderators, saved: req.query.saved === "1" });
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/moderators", settingsWriteLimiter, requireLevel(1), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const modsListDoc = await modsRepo.getModerators(channel.channelId);
    const moderatorIds = modsListDoc?.moderators || [];
    const overrides = await modPermissionOverridesRepo.listForChannel(channel.channelId);
    const allowedIds = new Set(
      moderatorIds.filter((id) => req.body[`allow.${id}`] === "on")
    );

    for (const id of moderatorIds) {
      const wasAllowed = overrides.get(String(id))?.canEditSettings !== false;
      const nowAllowed = allowedIds.has(id);
      if (wasAllowed === nowAllowed) continue;

      if (nowAllowed) {
        await modPermissionOverridesRepo.allow(channel.channelId, id);
      } else {
        await modPermissionOverridesRepo.deny(channel.channelId, id, req.user.userId);
      }
      await settingsChangeLogRepo.logChange({
        channelLogin: req.params.channel, user: req.user, category: "settings",
        action: "update", target: `moderator-permission:${id}`,
        before: wasAllowed, after: nowAllowed,
      });
    }

    res.redirect(`/${req.params.channel}/settings/moderators?saved=1`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
