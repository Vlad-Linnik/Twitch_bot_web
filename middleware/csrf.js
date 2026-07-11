// Synchronizer-token CSRF check for state-changing forms, separate from the
// OAuth `state` param check in twitch/oauthClient.js (that guards the Twitch
// redirect itself, not our own forms).
const crypto = require("crypto");

// Only issues a token for logged-in users, since the only forms that need one
// (settings, logout) are only rendered when req.session.user is set - this
// avoids persisting a session doc for anonymous visitors who never see a form.
function ensureToken(req, res, next) {
  if (req.session.user) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(24).toString("hex");
    }
    res.locals.csrfToken = req.session.csrfToken;
  }
  next();
}

function verifyToken(req, res, next) {
  const submitted = req.body && req.body._csrf;
  if (!submitted || !req.session.csrfToken || submitted !== req.session.csrfToken) {
    return res.status(403).render("errors/403", {
      requiredLevel: null,
      message: "Form expired or invalid. Please refresh and try again.",
    });
  }
  next();
}

module.exports = { ensureToken, verifyToken };
