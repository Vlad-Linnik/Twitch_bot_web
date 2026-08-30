// Tier-0 admin pages for the AI mention replies: the global settings, the per-channel fine
// settings that moved off the channel owner's own page, and the six tables the feature keeps -
// filter, answer cache, channel memory, viewer memory, call journal, ignore list.
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
const aiUserMemoryRepo = require("../db/aiUserMemoryRepo");
const aiRapportRepo = require("../db/aiRapportRepo");
const userStatsRepo = require("../db/userStatsRepo");
const adminActionLogsRepo = require("../db/adminActionLogsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { diffConfig } = require("../lib/settingsDiff");
const { parseSubmittedConfig } = require("../lib/settingsValidation");
const aiValidation = require("../lib/aiSettingsValidation");

const router = express.Router();
const requireAdmin = requireLevel(0);

const LOG_PAGE_SIZE = 100;

// Какой канал открывать, когда в адресе он не указан. НЕ первый по алфавиту: каналы
// сортируются по логину, и первым легко оказывается тот, на котором ИИ вообще не включён -
// страница тогда честно сообщает «бот ничего не запомнил», но про не тот канал, и выглядит это
// как потерянные данные. Берём первый канал с включёнными ИИ-ответами: именно его данные тут и
// курируют. Если таких нет, поведение прежнее.
async function defaultChannel(channels) {
  if (!channels.length) return null;
  const configs = await Promise.all(channels.map((c) => channelConfigRepo.getConfig(c.channelLogin)));
  const withAi = channels.find((c, i) => configs[i].ai && configs[i].ai.enabled);
  return (withAi || channels[0]).channelLogin;
}

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
      for (const field of ["enabled", "tone", "cheatsheet", "memoryShare"]) {
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
    // Тот же выбор канала по умолчанию, что у кэша и памяти: первый с включёнными ИИ-ответами,
    // а не первый по алфавиту.
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (await defaultChannel(channels));
    const entries = selected ? await aiFilterRepo.listForChannel(selected) : [];
    res.render("adminAiFilter", {
      tab: "ai",
      aiTab: "filter",
      channels,
      selected,
      entries,
      editError: String(req.query.error || ""),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/filter", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const key = await aiFilterRepo.upsert({ channelLogin: channel, text: req.body.text, answer: req.body.answer, source: "admin" });
    if (key) {
      await adminActionLogsRepo.logAction({ admin: req.user, action: "ai.filter.upsert", target: channel + "/" + key });
    }
    res.redirect(`/admin/ai/filter?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

// Правка строки на месте. Раньше страница умела только добавлять и удалять, а исправить ответ,
// который написала модель, можно было лишь набрав его текст-ключ заново в форме добавления - то
// есть вслепую и с риском завести вторую строку вместо правки первой.
router.post("/admin/ai/filter/edit", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const result = await aiFilterRepo.updateEntry({
      channelLogin: channel,
      text: req.body.text,
      newText: req.body.newText,
      answer: req.body.answer,
    });
    if (result.ok) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.filter.edit",
        target: channel + "/" + String(req.body.text || ""),
        details: { after: result.key, answer: String(req.body.answer || "").slice(0, 500) },
      });
    }
    const failed = result.ok ? "" : "&error=" + encodeURIComponent(result.reason || "failed");
    res.redirect(`/admin/ai/filter?channel=${encodeURIComponent(channel)}${failed}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/filter/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    await aiFilterRepo.remove(channel, req.body.text);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.filter.delete",
      target: channel + "/" + String(req.body.text || ""),
    });
    res.redirect(`/admin/ai/filter?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

// --- answer cache -------------------------------------------------------------------------------

router.get("/admin/ai/cache", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (await defaultChannel(channels));
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
    const selected = req.query.channel || (await defaultChannel(channels));
    const [entries, config, channelConfig] = await Promise.all([
      selected ? aiMemoryRepo.listForChannel(selected) : Promise.resolve([]),
      aiConfigRepo.getConfig(),
      selected ? channelConfigRepo.getConfig(selected) : Promise.resolve({}),
    ]);
    // Пустой список значит разное: «бот пока ничего не запомнил» и «на этом канале ИИ выключен,
    // и запоминать было неоткуда». Второе выглядит как пропажа данных, если об этом не сказать.
    const channelAiEnabled = Boolean(channelConfig.ai && channelConfig.ai.enabled);
    res.render("adminAiMemory", {
      tab: "ai",
      aiTab: "memory",
      channels,
      selected,
      entries,
      config,
      channelAiEnabled,
      editError: req.query.error || null,
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

router.post("/admin/ai/memory/edit", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const result = await aiMemoryRepo.updateFact(channel, req.body.key, req.body.fact, req.user.login || req.user.userId);
    if (result.ok) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.memory.edit",
        target: channel,
        details: { before: String(req.body.key || ""), after: String(req.body.fact || "").slice(0, aiMemoryRepo.MAX_FACT_LEN) },
      });
    }
    const failed = result.ok ? "" : "&error=" + encodeURIComponent(result.reason || "failed");
    res.redirect(`/admin/ai/memory?channel=${encodeURIComponent(channel)}${failed}`);
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

// --- viewer memory ------------------------------------------------------------------------------

// Что бот знает про отдельных зрителей. Отдельная страница, а не колонка на странице памяти
// канала: разбирают тут не факт, а человека - «что бот вообще про него насобирал» - и строки
// поэтому сгруппированы по адресату.
//
// Смотреть сюда может только админ, как и в память канала: строку про зрителя мог продиктовать
// кто угодно из чата, и владельцу канала это не список фактов, а список чужих слов о его зрителях.
router.get("/admin/ai/viewers", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (await defaultChannel(channels));
    const [groups, config, channelConfig] = await Promise.all([
      selected ? aiUserMemoryRepo.listForChannel(selected) : Promise.resolve([]),
      aiConfigRepo.getConfig(),
      selected ? channelConfigRepo.getConfig(selected) : Promise.resolve({}),
    ]);
    const channelAiEnabled = Boolean(channelConfig.ai && channelConfig.ai.enabled);

    // С кем этот канал делит память о зрителях. Считается здесь, а не показывается одной галкой,
    // потому что страница отвечает на вопрос «что бот знает про этого человека», а с включённым
    // обменом ответ на него шире списка ниже: удаление строки здесь не трогает её двойника,
    // записанного в соседнем чате, - там своя строка со своим автором.
    let memoryPool = [];
    if (channelConfig.ai && channelConfig.ai.memoryShare) {
      const others = channels.filter((c) => c.channelLogin !== selected);
      const otherConfigs = await Promise.all(others.map((c) => channelConfigRepo.getConfig(c.channelLogin)));
      memoryPool = others
        .filter((c, i) => otherConfigs[i].ai && otherConfigs[i].ai.memoryShare)
        .map((c) => c.channelLogin);
    }

    res.render("adminAiViewers", {
      tab: "ai",
      aiTab: "viewers",
      channels,
      selected,
      groups,
      config,
      channelAiEnabled,
      memoryPool,
      editError: req.query.error || null,
      maxFactLen: aiUserMemoryRepo.MAX_FACT_LEN,
    });
  } catch (err) {
    next(err);
  }
});

// Добавление руками требует ника, а строка живёт под user-id: ники на Twitch меняются. Ник
// разрешается через UserIdentities - если бот этого человека ни разу не видел, записывать факт
// не на кого, и об этом надо сказать, а не молча ничего не сделать.
router.post("/admin/ai/viewers", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const identity = await userStatsRepo.findUserByName(req.body.login);
    if (!identity) {
      return res.redirect(
        `/admin/ai/viewers?channel=${encodeURIComponent(channel)}&error=unknownUser`
      );
    }
    const subject = { userId: identity.userId, login: identity.currentUserName };
    const key = await aiUserMemoryRepo.addManual(channel, subject, req.body.fact, req.user.login || req.user.userId);
    if (key) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.userMemory.add",
        target: channel + "/" + subject.login,
        details: { fact: String(req.body.fact || "").slice(0, aiUserMemoryRepo.MAX_FACT_LEN) },
      });
    }
    res.redirect(`/admin/ai/viewers?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/viewers/edit", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const result = await aiUserMemoryRepo.updateFact(
      channel,
      req.body.userId,
      req.body.key,
      req.body.fact,
      req.user.login || req.user.userId
    );
    if (result.ok) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.userMemory.edit",
        target: channel + "/" + String(req.body.userId || ""),
        details: { before: String(req.body.key || ""), after: String(req.body.fact || "").slice(0, aiUserMemoryRepo.MAX_FACT_LEN) },
      });
    }
    const failed = result.ok ? "" : "&error=" + encodeURIComponent(result.reason || "failed");
    res.redirect(`/admin/ai/viewers?channel=${encodeURIComponent(channel)}${failed}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/viewers/delete", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    await aiUserMemoryRepo.remove(channel, req.body.userId, req.body.key);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.userMemory.delete",
      target: channel + "/" + String(req.body.userId || ""),
      details: { key: String(req.body.key || "") },
    });
    res.redirect(`/admin/ai/viewers?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/viewers/clear-user", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const removed = await aiUserMemoryRepo.clearUser(channel, req.body.userId);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.userMemory.clearUser",
      target: channel + "/" + String(req.body.userId || ""),
      details: { removed },
    });
    res.redirect(`/admin/ai/viewers?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/viewers/clear", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const removed = await aiUserMemoryRepo.clearChannel(channel);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.userMemory.clear",
      target: channel,
      details: { removed },
    });
    res.redirect(`/admin/ai/viewers?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

// --- отношение к зрителям -----------------------------------------------------------------------

// Страница отвечает на один вопрос: что будет этому человеку за следующее нарушение. Само число
// шкалы без этого ответа мало о чём говорит, поэтому колонка «что будет» считается в репозитории
// копией правил бота (lib/rapport.js) и показывается рядом со счётом.
router.get("/admin/ai/rapport", requireAdmin, async (req, res, next) => {
  try {
    const channels = await channelsRepo.listAll();
    const selected = req.query.channel || (await defaultChannel(channels));
    const config = await aiConfigRepo.getConfig();
    const [rows, channelConfig] = await Promise.all([
      selected ? aiRapportRepo.listForChannel(selected, config) : Promise.resolve([]),
      selected ? channelConfigRepo.getConfig(selected) : Promise.resolve({}),
    ]);
    res.render("adminAiRapport", {
      tab: "ai",
      aiTab: "rapport",
      channels,
      selected,
      rows,
      config,
      channelAiEnabled: Boolean(channelConfig.ai && channelConfig.ai.enabled),
      // Общий пул виден и здесь, но значит другое, чем на странице памяти: по нему счёт засевается
      // ОДИН раз, при первом появлении человека на канале, а дальше строка живёт своей жизнью.
      memoryShare: Boolean(channelConfig.ai && channelConfig.ai.memoryShare),
      editError: req.query.error || null,
      minScore: aiRapportRepo.MIN_SCORE,
      maxScore: aiRapportRepo.MAX_SCORE,
    });
  } catch (err) {
    next(err);
  }
});

// Правится и существующая строка (по userId), и ещё не заведённая (по нику): выставить отношение
// наперёд - обычное желание, а строка появляется только у того, кто дожил до платного вызова. Ник
// разрешается через UserIdentities, как и на странице памяти: писать не на кого, если бот этого
// человека ни разу не видел, и об этом надо сказать, а не молча ничего не сделать.
router.post("/admin/ai/rapport/set", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    let userId = String(req.body.userId || "");
    let login = String(req.body.login || "");
    if (!userId) {
      const identity = await userStatsRepo.findUserByName(login);
      if (!identity) {
        return res.redirect(
          `/admin/ai/rapport?channel=${encodeURIComponent(channel)}&error=unknownUser`
        );
      }
      userId = identity.userId;
      login = identity.currentUserName;
    }
    const score = await aiRapportRepo.setScore(channel, userId, login, req.body.score, req.user.login || req.user.userId);
    if (score !== null) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.rapport.set",
        target: channel + "/" + (login || userId),
        details: { score },
      });
    }
    res.redirect(`/admin/ai/rapport?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

// Удаление, а не обнуление: ноль - это осознанное «отношусь нейтрально», а отсутствие строки
// означает, что человека здесь ещё не было, и при включённом пуле следующий его вопрос засеет счёт
// заново из соседнего канала. Две разные кнопки нужны именно потому, что это два разных решения.
router.post("/admin/ai/rapport/forget", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const removed = await aiRapportRepo.remove(channel, req.body.userId);
    if (removed) {
      await adminActionLogsRepo.logAction({
        admin: req.user,
        action: "ai.rapport.forget",
        target: channel + "/" + String(req.body.login || req.body.userId || ""),
        details: {},
      });
    }
    res.redirect(`/admin/ai/rapport?channel=${encodeURIComponent(channel)}`);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/ai/rapport/clear", settingsWriteLimiter, requireAdmin, verifyToken, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || "");
    const removed = await aiRapportRepo.clearChannel(channel);
    await adminActionLogsRepo.logAction({
      admin: req.user,
      action: "ai.rapport.clear",
      target: channel,
      details: { removed },
    });
    res.redirect(`/admin/ai/rapport?channel=${encodeURIComponent(channel)}`);
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
