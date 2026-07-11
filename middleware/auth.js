// Exposes req.user (or null) and makes it available to every view, so
// permission middleware and templates never have to reach into req.session directly.
function attachUser(req, res, next) {
  req.user = req.session.user || null;
  res.locals.user = req.user;
  next();
}

module.exports = attachUser;
