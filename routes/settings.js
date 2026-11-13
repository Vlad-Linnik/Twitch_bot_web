const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const { movedPermanently } = require("../lib/movedPermanently");
const modsRepo = require("../db/modsRepo");
const modPermissionOverridesRepo = require("../db/modPermissionOverridesRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const profileCacheRepo = require("../db/profileCacheRepo");
const { requireLevel, requireSectionEditAccess, exposeSectionEditAccess } = require("../middleware/permissions");
const moderatorSections = require("../lib/moderatorSections");
const settingsNavLib = require("../lib/settingsNav");
const { settingsNav } = require("../middleware/settingsNav");
const { sanitizeReturnTo } = require("../lib/returnTo");
const { verifyToken } = require("../middleware/csrf");
const { settingsWriteLimiter, autosaveLimiter } = require("../middleware/rateLimiters");
const { MAX_LIST_ITEMS, sanitizeWord, parseSubmittedConfig } = require("../lib/settingsValidation");
const { DURATION_PRESETS, PERMANENT, normalizeSignatureEntry, parseSignatureEntry } = require("../lib/spamSignatureValidation");
const { diffConfig } = require("../lib/settingsDiff");
const { AI_LOG_MESSAGES_OPTIONS } = require("../lib/unbanBureauValidation");
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

// The bare address opens the first page of the settings catalog (lib/settingsNav.js) - there is
// no settings front page any more, every page is one click away in the panel. Kept as a route,
// not dropped, because links, bookmarks and the site nav all point here.
router.get("/:channel/settings", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");
    res.redirect(302, settingsNavLib.firstPagePath(channel.channelLogin));
  } catch (err) {
    next(err);
  }
});

// The pages made of built-in command rows (lib/settingsNav.js's COMMAND_PAGES). They save through
// the POST below, like the single page they were split out of.
for (const [pageKey, page] of Object.entries(settingsNavLib.COMMAND_PAGES)) {
  router.get(
    `/:channel/settings/${pageKey}`,
    requireLevel(2),
    exposeSectionEditAccess("settings"),
    settingsNav(page.navKey),
    async (req, res, next) => {
      try {
        const channel = await channelsRepo.findByLogin(req.params.channel);
        if (!channel) return res.status(404).render("errors/404");

        const config = await channelConfigRepo.getConfig(req.params.channel);
        const commandNames = Object.keys(config.commands);
        res.render("channelSettingsCategory", {
          channel,
          config,
          page: { key: pageKey, navKey: page.navKey },
          names: page.commands.filter((name) => config.commands[name]),
          otherNames: pageKey === "bot" ? settingsNavLib.unplacedCommands(commandNames) : [],
          // emoteImages.js's getSevenTvLinkStatus is already fail-soft (a 7TV outage resolves to
          // "not linked" rather than rejecting), so no extra catch needed here.
          sevenTvStatus: pageKey === "stats" ? await getSevenTvLinkStatus(channel.channelId) : null,
          returnTo: `/${channel.channelLogin}/settings/${pageKey}`,
          saved: req.query.saved === "1",
        });
      } catch (err) {
        next(err);
      }
    }
  );
}

// Where a no-JS save of the settings form goes back to: the page that sent it, if it is one of
// this channel's settings pages, else the catalog's first page.
function settingsReturnPath(req, channel) {
  const returnTo = sanitizeReturnTo(req.body.returnTo);
  const prefix = `/${channel.channelLogin}/settings/`;
  const path = returnTo && returnTo.startsWith(prefix) ? returnTo.split(/[?#]/)[0] : settingsNavLib.firstPagePath(channel.channelLogin);
  return `${path}?saved=1`;
}

router.post("/:channel/settings", autosaveLimiter, requireSectionEditAccess("settings"), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const existing = await channelConfigRepo.getConfig(req.params.channel);
    const parsed = await keepToEditableSections(req, channel, existing, parseSubmittedConfig(req.body, existing));

    await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);
    await logConfigChanges(req.params.channel, req.user, existing, parsed);

    respondSaved(req, res, settingsReturnPath(req, channel));
  } catch (err) {
    next(err);
  }
});

// A moderator saves only the sections they may change: every config form posts through the same
// parseSubmittedConfig, which takes any field present in the body, so the route's own section
// gate alone would let a forged form reach another section's fields. See
// lib/moderatorSections.js's restrictConfigToSections. req.permissionLevel is set by the
// route's requireSectionEditAccess.
async function keepToEditableSections(req, channel, existing, parsed) {
  if (req.permissionLevel <= 1) return parsed;
  const override = await modPermissionOverridesRepo.get(channel.channelId, req.user.userId);
  return moderatorSections.restrictConfigToSections(existing, parsed, (key) =>
    moderatorSections.canEditSection(req.permissionLevel, override, key)
  );
}

// Command-group settings moved off the main settings page onto their own sub-pages
// (custom commands, variables) - each renders a subset of the command rows and POSTs
// back through the same parseSubmittedConfig, which carries every unrendered field
// over from the stored config (see lib/settingsValidation.js's partial-form contract).
function registerConfigSubPage(basePath, section, navKey, viewName, getExtras = null) {
  router.get(`/:channel${basePath}`, requireLevel(2), exposeSectionEditAccess(section), settingsNav(navKey), async (req, res, next) => {
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

  router.post(`/:channel${basePath}`, autosaveLimiter, requireSectionEditAccess(section), verifyToken, async (req, res, next) => {
    try {
      const channel = await channelsRepo.findByLogin(req.params.channel);
      if (!channel) return res.status(404).render("errors/404");

      const existing = await channelConfigRepo.getConfig(req.params.channel);
      const parsed = await keepToEditableSections(req, channel, existing, parseSubmittedConfig(req.body, existing));
      await channelConfigRepo.saveConfig(req.params.channel, parsed, req.user.userId);
      await logConfigChanges(req.params.channel, req.user, existing, parsed);

      respondSaved(req, res, `/${req.params.channel}${basePath}?saved=1`);
    } catch (err) {
      next(err);
    }
  });
}

registerConfigSubPage("/settings/custom-commands", "commands", "customCommandsSettings", "channelCustomCommandsSettings", async (channelLogin) => ({
  customCommandCount: (await customCommandsRepo.list(channelLogin)).length,
}));
registerConfigSubPage("/settings/variables", "commands", "variablesSettings", "channelVariablesSettings");
// The sub-page's address before counters were renamed to variables.
router.all("/:channel/settings/counters", movedPermanently((req) => `/${encodeURIComponent(req.params.channel)}/settings/variables`));
// The Amnesty Bureau's knobs used to sit in the main settings form, with the settings grid's own
// "Бюро амнистии" tile jumping straight into the review console. The tile now lands here instead and
// this page is what offers the console - the settings are a channel-level decision, the console is a
// shift at a desk, and the grid is a settings grid.
// The AI log-window select is rendered from the validator's own list, so the page can only offer
// values the save accepts.
registerConfigSubPage("/settings/unban-bureau", "bureau", "unbanBureau", "channelUnbanBureauSettings", async () => ({
  aiLogMessagesOptions: AI_LOG_MESSAGES_OPTIONS,
}));

// Banned Words and Spam Signatures moved off the main settings page onto
// their own sub-pages (search + add/edit/delete instead of one big textarea
// blob) - both are just a flat string array on the config, so the add/edit/
// delete routes share this factory instead of tripling the same CRUD logic.
// targetLabel names the list in SettingsChangeLog entries (e.g. "bannedWords.words") -
// derived once per registration rather than from basePath, since the two aren't always
// the same shape as the underlying config field.
function registerWordListRoutes(basePath, section, navKey, viewName, getList, targetLabel) {
  router.get(`/:channel${basePath}`, requireLevel(2), exposeSectionEditAccess(section), settingsNav(navKey), async (req, res, next) => {
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

  router.post(`/:channel${basePath}/add`, settingsWriteLimiter, requireSectionEditAccess(section), verifyToken, async (req, res, next) => {
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
      // Anchored at the list container (partials/wordListEditor.ejs's id="word-list") rather
      // than reloading to the top of the settings page - the editor can render well below other
      // per-channel settings sections above it.
      res.redirect(`/${req.params.channel}${basePath}#word-list`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/edit`, settingsWriteLimiter, requireSectionEditAccess(section), verifyToken, async (req, res, next) => {
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
      // Anchored at the list container (partials/wordListEditor.ejs's id="word-list") rather
      // than reloading to the top of the settings page - the editor can render well below other
      // per-channel settings sections above it.
      res.redirect(`/${req.params.channel}${basePath}#word-list`);
    } catch (err) {
      next(err);
    }
  });

  router.post(`/:channel${basePath}/delete`, settingsWriteLimiter, requireSectionEditAccess(section), verifyToken, async (req, res, next) => {
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
      // Anchored at the list container (partials/wordListEditor.ejs's id="word-list") rather
      // than reloading to the top of the settings page - the editor can render well below other
      // per-channel settings sections above it.
      res.redirect(`/${req.params.channel}${basePath}#word-list`);
    } catch (err) {
      next(err);
    }
  });
}

registerWordListRoutes("/settings/banned-words", "chatModeration", "bannedWords", "channelBannedWords", (config) => config.bannedWords.words, "bannedWords.words");

// Spam signatures: each entry needs a word PLUS an optional per-signature ban duration (falling
// back to permanent) and an optional per-signature reason (falling back to the channel's shared
// spamBanReason at ban time - see TwitchBot/commands/msgHandle.js's spam_protection). That's a
// richer shape than registerWordListRoutes' plain-string CRUD handles, so this gets its own
// routes instead of being squeezed through that factory.
router.get("/:channel/settings/spam-signatures", requireLevel(2), exposeSectionEditAccess("chatModeration"), settingsNav("spamSignatures"), async (req, res, next) => {
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

router.post("/:channel/settings/spam-signatures/add", settingsWriteLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
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
    // Anchored at the list container (views/channelSpamSignatures.ejs's id="word-list", same
    // convention as the banned-words editor) rather than the top of the settings page.
    res.redirect(`/${req.params.channel}/settings/spam-signatures#word-list`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/spam-signatures/edit", settingsWriteLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const config = await channelConfigRepo.getConfig(req.params.channel);
    const signatures = config.spamSignatures.map(normalizeSignatureEntry);
    const before = [...signatures];
    const index = parseInt(req.body.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= signatures.length) {
      return res.redirect(`/${req.params.channel}/settings/spam-signatures#word-list`);
    }

    const parsed = parseSignatureEntry(req.body);
    if (!parsed.ok) {
      return res.redirect(`/${req.params.channel}/settings/spam-signatures?edit=${index}&error=${parsed.error}#word-list`);
    }

    signatures[index] = parsed.entry;
    config.spamSignatures = signatures;
    await channelConfigRepo.saveConfig(req.params.channel, config, req.user.userId);
    await settingsChangeLogRepo.logChange({
      channelLogin: req.params.channel, user: req.user, category: "settings",
      action: "update", target: "spamSignatures", before, after: [...signatures],
    });
    // Anchored at the list container - same reasoning as the /add route above.
    res.redirect(`/${req.params.channel}/settings/spam-signatures#word-list`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/spam-signatures/delete", settingsWriteLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
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
    // Anchored at the list container - same reasoning as the /add route above.
    res.redirect(`/${req.params.channel}/settings/spam-signatures#word-list`);
  } catch (err) {
    next(err);
  }
});

router.post("/:channel/settings/banned-words/timeout-reason", autosaveLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
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
router.post("/:channel/settings/banned-words/detection-toggle", autosaveLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
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
router.post("/:channel/settings/spam-signatures/reason", autosaveLimiter, requireSectionEditAccess("chatModeration"), verifyToken, async (req, res, next) => {
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
router.get("/:channel/settings/change-log", requireLevel(2), exposeSectionEditAccess("settings"), settingsNav("changeLog"), async (req, res, next) => {
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

// Resolves "moderator-permission:<id>[:<section>]" targets to a display name (falls back to the raw id if
// the profile can't be fetched) and attaches a describeChange() one-liner to every entry, so the
// view never has to render raw before/after JSON as the primary summary.
async function describeEntries(entries, t) {
  const moderatorIds = [
    ...new Set(
      entries
        .filter((e) => e.category === "settings")
        .map((e) => moderatorSections.parsePermissionTarget(e.target)?.userId)
        .filter(Boolean)
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

// Owner-only: per moderator and per section (lib/moderatorSections.js), whether that moderator may
// CHANGE it - viewing is unaffected. requireLevel(1), not (2): only the owner (or admin) should get
// to reassign another moderator's permissions.
async function loadModeratorRows(channel) {
  const modsListDoc = await modsRepo.getModerators(channel.channelId);
  const moderatorIds = (modsListDoc?.moderators || []).map(String);
  const [profiles, overrides] = await Promise.all([
    profileCacheRepo.getOrFetchProfiles(moderatorIds).catch(() => new Map()),
    modPermissionOverridesRepo.listForChannel(channel.channelId),
  ]);
  const moderators = moderatorIds.map((id) => ({
    userId: id,
    userName: profiles.get(id)?.displayName || id,
    allowed: moderatorSections.allowedMap(overrides.get(id)),
  }));
  return { moderatorIds, overrides, moderators };
}

router.get("/:channel/settings/moderators", requireLevel(1), exposeSectionEditAccess("settings"), settingsNav("moderators"), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const { moderators } = await loadModeratorRows(channel);
    res.render("channelModeratorPermissions", {
      channel,
      moderators,
      sections: moderatorSections.MODERATOR_SECTIONS,
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

// Two callers: public/js/moderator-permissions.js posts the whole form on every checkbox change
// with Accept: application/json and patches the rows from the answer; without JS it is a plain
// form POST and a redirect back. One SettingsChangeLog row per moderator and section that flipped.
router.post("/:channel/settings/moderators", settingsWriteLimiter, requireLevel(1), verifyToken, async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const { moderatorIds, overrides } = await loadModeratorRows(channel);
    const submitted = moderatorSections.parsePermissionsForm(req.body, moderatorIds);

    for (const [id, deny] of submitted) {
      const before = overrides.get(id) || null;
      const changes = moderatorSections.diffSections(before, { deny });
      // A legacy row (canEditSettings) whose meaning is unchanged is left alone too: rewriting it
      // would only change its shape, and the row would be logged as touched for nothing.
      if (changes.length === 0) continue;

      await modPermissionOverridesRepo.setDenied(channel.channelId, id, deny, req.user.userId);
      for (const change of changes) {
        await settingsChangeLogRepo.logChange({
          channelLogin: req.params.channel, user: req.user, category: "settings",
          action: "update", target: moderatorSections.permissionTarget(id, change.key),
          before: change.before, after: change.after,
        });
      }
    }

    if (wantsJson(req)) {
      const { moderators } = await loadModeratorRows(channel);
      return res.json({ ok: true, moderators: moderators.map(({ userId, allowed }) => ({ userId, allowed })) });
    }
    // Anchored at the table (views/channelModeratorPermissions.ejs's id="moderator-list") rather
    // than the very top of the page - a long moderator roster means the submit button (and the
    // rows the visitor just toggled) can be well below the page heading.
    res.redirect(`/${req.params.channel}/settings/moderators?saved=1#moderator-list`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
