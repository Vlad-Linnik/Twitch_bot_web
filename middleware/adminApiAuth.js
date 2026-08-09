const crypto = require("crypto");
const env = require("../config/env");

// Bearer-token gate for the read-only /admin/api/* routes - a machine credential, not a browser
// session, so unlike every other route in this app there is no req.user at all here. Fails
// closed to 404 (indistinguishable from "route doesn't exist") when no token is configured,
// so an unset ADMIN_API_TOKEN can never accidentally leave this open. Any malformed/mismatched
// header gets the same 401 - no distinction that would help an attacker tell "wrong token" apart
// from "no token".
function requireApiToken(req, res, next) {
  const expected = env.adminApiToken;
  if (!expected) return res.status(404).json({ error: "not_found" });

  const header = req.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  const ok =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

module.exports = requireApiToken;
