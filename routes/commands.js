const express = require("express");
const commandGroups = require("../data/commands");
const channelsRepo = require("../db/channelsRepo");
const channelConfigRepo = require("../db/channelConfigRepo");
const customCommandsRepo = require("../db/customCommandsRepo");
const { resolveCommandGroups, buildCustomCommandsGroup, partitionIntoSections } = require("../lib/commandsView");

const router = express.Router();

router.get("/commands", async (req, res, next) => {
  try {
    const channels = await channelsRepo.listEnabled();

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
