const express = require("express");
const commandGroups = require("../data/commands");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const { getCurrentCategory } = require("../twitch/currentCategory");
const { resolveCommandGroups, buildCustomCommandsGroups, partitionIntoSections, dropDisabled } = require("../lib/commandsView");
const { computePermission } = require("../middleware/permissions");

const router = express.Router();

router.get("/commands", async (req, res, next) => {
  try {
    // Not listEnabled(): a channel's command docs (including its real custom_commands
    // rows) should stay reachable here regardless of whether the bot is currently
    // joining it - `enabled` only gates the bot's join list, not this reference page.
    const channels = await channelsRepo.listAll();

    // An unknown/malformed ?channel= just falls back to the defaults (same
    // fail-closed convention as middleware/permissions.js) rather than a 404 -
    // this route isn't channel-scoped, /commands itself must always render.
    const requestedLogin = typeof req.query.channel === "string" ? req.query.channel.trim().toLowerCase() : "";
    const selectedChannel = requestedLogin ? channels.find((c) => c.channelLogin === requestedLogin) || null : null;

    let channelCommandsConfig = null;
    let customCommands = [];
    let currentCategory = null;
    if (selectedChannel) {
      const config = await channelConfigRepo.getConfig(selectedChannel.channelLogin);
      channelCommandsConfig = config.commands;
      customCommands = await customCommandsRepo.list(selectedChannel.channelLogin);
      // Only pay for a live Helix call when it could actually change what's shown - same
      // economy as the bot's own resolveCommandText (TwitchBot/commands/CustomCommands.js),
      // which likewise skips the check entirely for commands with no category overrides.
      if (customCommands.some((c) => c.categoryTexts && c.categoryTexts.length)) {
        currentCategory = await getCurrentCategory(selectedChannel.channelId);
      }
    }

    // The channel's staff (level 2 or better) see every command with an enabled/disabled mark, so
    // they can tell what is switched off; everyone else sees only the commands that answer.
    const showStatus = selectedChannel
      ? (await computePermission(req.user?.userId ?? null, selectedChannel.channelLogin)) <= 2
      : false;

    let resolvedGroups = resolveCommandGroups(commandGroups, channelCommandsConfig);
    // In front, not behind: the channel's own custom commands are what most visitors
    // are actually looking for, so their groups lead both the "everyone" and
    // "moderators" sections (partitionIntoSections preserves resolvedGroups order).
    if (customCommands.length) resolvedGroups.unshift(...buildCustomCommandsGroups(customCommands, currentCategory));

    if (!showStatus) resolvedGroups = dropDisabled(resolvedGroups);

    const sections = partitionIntoSections(resolvedGroups);

    res.render("commands", { sections, channels, selectedChannel, showStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
