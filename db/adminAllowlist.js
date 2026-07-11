const env = require("../config/env");

function isAdmin(userId) {
  return env.adminUserIds.has(String(userId));
}

module.exports = { isAdmin };
