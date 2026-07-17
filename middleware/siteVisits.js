const siteVisitsRepo = require("../db/siteVisitsRepo");

// Counts a page view once per real page request, feeding the admin panel's Statistics tab.
// Mounted after express.static in app.js, so static assets (css/js/images) never reach this at
// all. The remaining traffic still includes pages polling their own live data (stats.json,
// search.json, mod-action-context.json, ...) - excluding .json keeps those background refreshes
// from inflating the count with requests nobody "visited". Fire-and-forget, same convention as
// CommandExecutionStats/GlobalEmoteStats on the bot side - never blocks the response.
module.exports = function siteVisits(req, res, next) {
  if (req.method === "GET" && !req.path.endsWith(".json")) {
    siteVisitsRepo.recordVisit().catch((err) => console.error("[siteVisits] recordVisit error:", err));
  }
  next();
};
