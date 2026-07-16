const express = require("express");
const commandGroups = require("../data/commands");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
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
    if (selectedChannel) {
      const config = await channelConfigRepo.getConfig(selectedChannel.channelLogin);
      channelCommandsConfig = config.commands;
      customCommands = await customCommandsRepo.list(selectedChannel.channelLogin);
    }

    const resolvedGroups = resolveCommandGroups(commandGroups, channelCommandsConfig);
    if (customCommands.length) resolvedGroups.push(buildCustomCommandsGroup(customCommands));

    const sections = partitionIntoSections(resolvedGroups);

    res.render("commands", { sections, channels, selectedChannel });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
