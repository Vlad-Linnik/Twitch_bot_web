const express = require("express");
const channelsRepo = require("../db/channelsRepo");
const { computePermission } = require("../middleware/permissions");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const channels = await channelsRepo.listEnabled();

    // Only worth the extra lookups for logged-in visitors - anonymous
    // visitors are always tier 3 and never get a settings/statistics link.
    if (req.user) {
      for (const channel of channels) {
        channel.canManage = (await computePermission(req.user.userId, channel.channelLogin)) <= 2;
      }
    } else {
      channels.forEach((channel) => (channel.canManage = false));
    }

    res.render("home", { channels });
  } catch (err) {
    next(err);
  }
});

module.exports = router;