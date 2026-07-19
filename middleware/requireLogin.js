// Logged-in-but-no-tier-gate check - the same 401/errors-403 pattern
// middleware/permissions.js's requireLevel uses, but for routes that aren't
// channel-scoped at all (so there's no permission tier to compute). Originally
// inline in routes/requestBot.js; extracted once a second route
// (routes/durakMultiplayer.js) needed the identical check.
function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).render("errors/403", { requiredLevel: null });
  }
  next();
}

module.exports = requireLogin;
