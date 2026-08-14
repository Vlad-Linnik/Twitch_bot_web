const express = require("express");
const commandGroups = require("../data/commands");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const { getCurrentCategory } = require("../twitch/currentCategory");
const { resolveCommandGroups, buildCustomCommandsGroup, partitionIntoSections } = require("../lib/commandsView");

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

    const resolvedGroups = resolveCommandGroups(commandGroups, channelCommandsConfig);
    // Unshift, not push: the channel's own custom commands are what most visitors
    // are actually looking for, so that group leads both the "everyone" and
    // "moderators" sections (partitionIntoSections preserves resolvedGroups order).
    if (customCommands.length) resolvedGroups.unshift(buildCustomCommandsGroup(customCommands, currentCategory));

    const sections = partitionIntoSections(resolvedGroups);

    res.render("commands", { sections, channels, selectedChannel });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
