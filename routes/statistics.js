const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const statsRepo = require("../db/statsRepo");
const { requireLevel } = require("../middleware/permissions");

const router = express.Router();

router.get("/:channel/statistics", requireLevel(2), async (req, res, next) => {
  try {
    const channel = await channelsRepo.findByLogin(req.params.channel);
    if (!channel) return res.status(404).render("errors/404");

    const [topChatters, topWords, totals, modActions, modUpTime] = await Promise.all([
      statsRepo.getTopChatters(channel.channelLogin),
      statsRepo.getTopWords(channel.channelLogin),
      statsRepo.getChannelTotals(channel.channelLogin),
      statsRepo.getRecentModActions(channel.channelLogin),
      statsRepo.getModUpTime(channel.channelId),
    ]);

    res.render("statistics", { channel, topChatters, topWords, totals, modActions, modUpTime });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
