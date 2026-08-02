// /<channel>/settings/custom-commands/commands - dashboard for creating, viewing and editing the
// channel's custom chat commands (the ones a mod would otherwise manage with !addcommand /
// !settimer / !setpin). Nested under the custom-commands settings sub-page (routes/settings.js's
// /:channel/settings/custom-commands) rather than a bare /:channel/commands, so the two pages
// read as parent/child instead of an unrelated jump.
//
// Fully gated at tier <= 2: these are WRITES to bot behaviour, not statistics. Every mutation is
// POST + CSRF + rate-limited, matching routes/settings.js - the other place this app writes
// config the bot acts on.
//
// This route must be mounted BEFORE routes/channelRedirect.js, whose bare "/:channel" would
// otherwise not conflict (this is 4 segments) - but keep it above anyway so the ordering intent
// stays obvious.
const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const settingsChangeLogRepo = require("../db/settingsChangeLogRepo");
const { requireLevel, requireSettingsEditAccess } = require("../middleware/permissions");
const { settingsWriteLimiter } = require("../middleware/rateLimiters");
const { verifyToken } = require("../middleware/csrf");
const {
  parseCommand,
  checkAliasConflicts,
  normalizeName,
  parseGroupName,
  MIN_TIMER_SECONDS,
  MAX_RESULT_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_CATEGORY_OVERRIDES,
  MAX_ALIASES,
  MAX_GROUP_LENGTH,
  ANNOUNCEMENT_COLORS,
} = require("../lib/commandValidation");

const router = express.Router();

// Same two-shapes-one-handler convention as routes/settings.js's autosave forms: a fetch with
// Accept: application/json gets JSON back (public/js/custom-commands.js's toggle handler), the
// plain no-JS form submit gets the classic redirect.
const wantsJson = (req) => (req.get("accept") || "").includes("application/json");

async function loadChannel(req, res) {
  const channel = await channelsRepo.findByLogin(req.params.channel);
  if (!channel) {
    res.status(404).render("errors/404");
    return null;
  }
  return channel;
}

// The bot stores timers in milliseconds; the form speaks seconds. Convert at the boundary rather
// than leaking the unit mismatch into the view.
const toSeconds = (timerMs) => (timerMs ? Math.round(timerMs / 1000) : null);

// Shared by the GET page render and the POST create/edit handler's JSON success response (see
// wireCommandsList below) - both need the exact same {commands, groupNames, sections} shape, and
// the POST path re-derives it fresh after a save rather than patching the pre-save snapshot, so a
// brand-new command or a group change lands in the right section without duplicating the grouping
// logic client-side.
async function buildCommandsView(channelLogin) {
  const commands = (await customCommandsRepo.list(channelLogin)).map((c) => ({
    command: c.command,
    result: c.result,
    timerSeconds: toSeconds(c.timer),
    pin: !!c.pin,
    announce: !!c.announce,
    announceColor: c.announceColor || "primary",
    enabled: c.enabled !== false,
    categoryTexts: c.categoryTexts || [],
    modOnly: !!c.modOnly,
    aliases: c.aliases || [],
    group: c.group || "",
  }));

  // Named groups first (alphabetical), then every ungrouped command as one final, header-less
  // section - so a channel that's never used groups renders exactly as before (a single flat
  // list). groupNames also feeds the create/edit form's <datalist> for autocomplete.
  const groupNames = [...new Set(commands.map((c) => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sections = [
    ...groupNames.map((name) => ({ name, commands: commands.filter((c) => c.group === name) })),
    { name: null, commands: commands.filter((c) => !c.group) },
  ].filter((section) => section.commands.length > 0);

  return { commands, groupNames, sections };
}

// res.render(view, locals, callback) - unlike res.app.render - automatically merges res.locals
// (t, csrfToken, ...), same as every other view in this app; wrapped in a Promise purely to
// await it inline. Mirrors routes/news.js's comment-thread partial re-render for the same reason:
// a fetch-based save patches one piece of the DOM instead of reloading the page, and the server
// stays the single source of truth for how that HTML is built instead of duplicating the
// sections/grouping markup in client-side JS.
function renderPartial(res, view, locals) {
  return new Promise((resolve, reject) => {
    res.render(view, locals, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

// The JSON success payload every mutation that changes the LIST's shape shares (create/edit,
// delete, setGroup): the freshly server-rendered list plus the alias-conflict snapshot the form's
// client-side checker keeps. Re-deriving the whole list rather than patching the pre-save snapshot
// is deliberate - a new command, a deleted one, or one that just moved group all have to land in
// the right section, and buildCommandsView above is the only place that grouping logic lives.
async function listResponse(res, channel) {
  const view = await buildCommandsView(channel.channelLogin);
  const html = await renderPartial(res, "partials/customCommandsList", { ...view, channel, maxGroupLength: MAX_GROUP_LENGTH });
  return {
    ok: true,
    html,
    commandsData: view.commands.map((c) => ({ command: c.command, aliases: c.aliases })),
  };
}

router.get("/:channel/settings/custom-commands/commands", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await loadChannel(req, res);
    if (!channel) return;

    const { commands, sections, groupNames } = await buildCommandsView(channel.channelLogin);

    res.render("customCommands", {
      channel,
      commands,
      sections,
      groupNames,
      minTimerSeconds: MIN_TIMER_SECONDS,
      maxResultLength: MAX_RESULT_LENGTH,
      maxCategoryLength: MAX_CATEGORY_LENGTH,
      maxCategoryOverrides: MAX_CATEGORY_OVERRIDES,
      maxAliases: MAX_ALIASES,
      maxGroupLength: MAX_GROUP_LENGTH,
      announcementColors: ANNOUNCEMENT_COLORS,
      error: req.query.error || null,
      // Only meaningful alongside error === "alias_conflict"/"name_conflict" - which existing
      // command the rejected name/alias collided with, so the banner can name it instead of just
      // saying "try something else".
      conflictsWith: req.query.conflictsWith || null,
      saved: req.query.saved || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:channel/settings/custom-commands/commands",
  settingsWriteLimiter,
  requireSettingsEditAccess(),
  verifyToken,
  async (req, res, next) => {
    try {
      const channel = await loadChannel(req, res);
      if (!channel) return;

      const back = `/${channel.channelLogin}/settings/custom-commands/commands`;

      // Delete lives in the row's "..." menu now (partials/customCommandRow.ejs). JSON-aware for
      // the same reason the toggles are: removing one row shouldn't reload a possibly long list
      // and throw away the visitor's scroll position - the list partial is re-rendered and swapped
      // in instead.
      if (req.body.action === "delete") {
        const name = normalizeName(req.body.name);
        if (!name) {
          if (wantsJson(req)) return res.status(400).json({ ok: false, error: "name_required" });
          return res.redirect(`${back}?error=name_required`);
        }
        const before = await customCommandsRepo.findOne(channel.channelLogin, name);
        await customCommandsRepo.remove(channel.channelLogin, name);
        if (before) {
          await settingsChangeLogRepo.logChange({
            channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
            action: "delete", target: name, before, after: null,
          });
        }
        if (wantsJson(req)) return res.json(await listResponse(res, channel));
        return res.redirect(`${back}?saved=deleted`);
      }

      // Moving a command into another group (or into a brand-new one, or out of every group when
      // the field is left blank). Its own action rather than a field on the create/edit form: the
      // group is now assigned from the list itself - the row's "..." menu and drag-and-drop
      // (public/js/custom-commands.js) - so a mod can reorganize a channel's commands without
      // loading each one back into the form. Every other field is carried over untouched.
      if (req.body.action === "setGroup") {
        const name = normalizeName(req.body.name);
        const parsedGroup = parseGroupName(req.body.group);
        if (!parsedGroup.ok) {
          if (wantsJson(req)) return res.status(400).json({ ok: false, error: parsedGroup.error });
          return res.redirect(`${back}?error=${parsedGroup.error}`);
        }
        const before = name ? await customCommandsRepo.findOne(channel.channelLogin, name) : null;
        if (!before) {
          if (wantsJson(req)) return res.status(404).json({ ok: false, error: "name_required" });
          return res.redirect(`${back}?error=name_required`);
        }
        // A no-op move (dropping a command back into the group it already sits in) still repaints
        // the list, but must not write a settings-log entry for a change that didn't happen.
        if ((before.group || "") !== parsedGroup.group) {
          const after = await customCommandsRepo.save(channel.channelLogin, { ...before, group: parsedGroup.group });
          await settingsChangeLogRepo.logChange({
            channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
            action: "update", target: name, before, after,
          });
        }
        if (wantsJson(req)) return res.json({ ...(await listResponse(res, channel)), moved: name });
        return res.redirect(`${back}?saved=1`);
      }

      // The list's per-row toggle (there is no "enabled" checkbox on the create/edit form
      // anymore - see views/customCommands.ejs) flips enabled on an already-saved command
      // without touching any of its other fields. JSON-aware (see wantsJson above) so
      // public/js/custom-commands.js can flip it without a full page reload - the classic
      // redirect used to send every visitor back to the top of a possibly long command list just
      // to see one switch move, with the CSS transition invisible because the page never
      // actually animated it, it just reappeared already in its new state after reloading.
      if (req.body.action === "toggle") {
        const name = normalizeName(req.body.name);
        if (!name) {
          if (wantsJson(req)) return res.status(400).json({ ok: false, error: "name_required" });
          return res.redirect(`${back}?error=name_required`);
        }
        const before = await customCommandsRepo.findOne(channel.channelLogin, name);
        if (!before) {
          if (wantsJson(req)) return res.status(404).json({ ok: false, error: "name_required" });
          return res.redirect(`${back}?error=name_required`);
        }
        const after = await customCommandsRepo.save(channel.channelLogin, { ...before, enabled: before.enabled === false });
        await settingsChangeLogRepo.logChange({
          channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
          action: "update", target: name, before, after,
        });
        if (wantsJson(req)) return res.json({ ok: true, enabled: after.enabled !== false });
        return res.redirect(`${back}?saved=1`);
      }

      // The group header's master switch (views/customCommands.ejs) - flips EVERY command in one
      // named group to the same enabled state in one request. Mirrors the single toggle above
      // (JSON-aware, same fallback), but the target state is derived rather than just inverted:
      // if any member is currently enabled, the click means "turn the group off"; only when every
      // member is already off does it mean "turn the group on". That matches a master-switch
      // showing "on" for a fully-or-partly-enabled group and "off" only once nothing in it runs.
      if (req.body.action === "toggleGroup") {
        const group = String(req.body.group || "").trim();
        const members = group ? (await customCommandsRepo.list(channel.channelLogin)).filter((c) => (c.group || "") === group) : [];
        if (!members.length) {
          if (wantsJson(req)) return res.status(404).json({ ok: false, error: "group_required" });
          return res.redirect(`${back}?error=group_required`);
        }
        const newEnabled = !members.some((c) => c.enabled !== false);
        const toFlip = members.filter((c) => (c.enabled !== false) !== newEnabled);
        for (const before of toFlip) {
          const after = await customCommandsRepo.save(channel.channelLogin, { ...before, enabled: newEnabled });
          await settingsChangeLogRepo.logChange({
            channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
            action: "update", target: before.command, before, after,
          });
        }
        if (wantsJson(req)) return res.json({ ok: true, enabled: newEnabled, commands: members.map((c) => c.command) });
        return res.redirect(`${back}?saved=1`);
      }

      // A variable number of category-override rows (see views/customCommands.ejs, rendered
      // progressively client-side) - urlencoded bodies collapse a single repeated field name to
      // a bare string instead of a one-element array, so normalize both categoryName/
      // categoryResult to arrays before zipping them.
      const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
      const categoryNames = toArray(req.body.categoryName);
      const categoryResults = toArray(req.body.categoryResult);
      const categoryTexts = categoryNames.map((category, i) => ({ category, result: categoryResults[i] }));

      // The create/edit form has no "enabled" checkbox (that's the list's per-row toggle now), so
      // saving text/timer/pin/etc changes must not silently flip a command's enabled state - carry
      // it over from the existing row, defaulting to enabled for a brand-new command.
      const name = normalizeName(req.body.name);
      const before = name ? await customCommandsRepo.findOne(channel.channelLogin, name) : null;

      // Same rules the bot enforces in chat - see lib/commandValidation.js for why that matters.
      const parsed = parseCommand({
        name: req.body.name,
        result: req.body.result,
        timerSeconds: req.body.timerSeconds,
        pin: req.body.pin,
        announce: req.body.announce,
        announceColor: req.body.announceColor,
        enabled: before ? before.enabled !== false : true,
        categoryTexts,
        modOnly: req.body.modOnly,
        aliases: req.body.aliases,
        // The create/edit form has no group field anymore (that's the list's "..." menu and
        // drag-and-drop now, via the setGroup action above), so - exactly like `enabled` - saving
        // a command's text/timer/pin must not silently drop it out of its group. Carry it over
        // from the existing row; a brand-new command starts ungrouped and gets moved afterwards.
        group: before ? before.group || "" : "",
      });
      if (!parsed.ok) {
        if (wantsJson(req)) return res.status(400).json({ ok: false, error: parsed.error });
        return res.redirect(`${back}?error=${parsed.error}`);
      }

      // A name/alias can't collide with another command's name or alias in this channel - the
      // bot's trigger lookup can't tell two commands apart if they both claim the same trigger.
      // Excludes the command being saved itself, so re-saving it with its own unchanged name/
      // aliases isn't flagged as conflicting with itself.
      const others = (await customCommandsRepo.list(channel.channelLogin)).filter((c) => c.command !== parsed.command.command);
      const conflict = checkAliasConflicts(parsed.command.command, parsed.command.aliases, others);
      if (!conflict.ok) {
        if (wantsJson(req)) return res.status(409).json({ ok: false, error: conflict.error, conflictsWith: conflict.conflictsWith });
        return res.redirect(`${back}?error=${conflict.error}&conflictsWith=${encodeURIComponent(conflict.conflictsWith)}`);
      }

      const after = await customCommandsRepo.save(channel.channelLogin, parsed.command);
      await settingsChangeLogRepo.logChange({
        channelLogin: channel.channelLogin, user: req.user, category: "custom_command",
        action: before ? "update" : "add", target: parsed.command.command, before, after,
      });
      // The running bot re-reads custom_commands every 10s (CustomCommands.REFRESH_INTERVAL_MS),
      // so this is live in chat within seconds - no restart, no extra signal to send.
      if (wantsJson(req)) return res.json(await listResponse(res, channel));
      res.redirect(`${back}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
