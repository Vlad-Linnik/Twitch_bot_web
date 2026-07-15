const express = require("express");

const router = express.Router();

// Fully static, fully localized (config/locales' "privacy" section) - the policy text
// itself is content, so it lives in the locale files, not here. Linked from the
// site-wide footer in views/partials/foot.ejs.
router.get("/privacy", (req, res) => {
  res.render("privacy");
});

module.exports = router;
