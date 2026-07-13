// The old /<channel> dashboard merged into /<channel>/statistics/chat (see routes/statistics.js).
// This keeps the bare URL alive as a permanent redirect for old links and muscle memory.
//
// MOUNTING: this router owns a ONE-SEGMENT wildcard ("/:channel"), so it must be mounted LAST in
// routes/index.js. Ahead of the static pages it would swallow "/commands", "/about", "/games" and
// "/settings" as channel names.
const express = require("express");

const router = express.Router();

router.get("/:channel", (req, res) => {
  const suffix = req.query.period ? `?period=${encodeURIComponent(req.query.period)}` : "";
  res.redirect(301, `/${encodeURIComponent(req.params.channel)}/statistics/chat${suffix}`);
});

module.exports = router;
