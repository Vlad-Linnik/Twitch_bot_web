// Creates a real, valid express-session doc directly in Mongo (bypassing the
// Twitch OAuth flow) and signs the matching session cookie the same way
// express-session does, so a request carrying it is treated as fully logged
// in - see routes/authRoutes.js's callback for the `req.session.user` shape
// this fakes ({ userId, login, displayName, avatarUrl }).
//
// Needs a real MongoDB reachable at MONGODB_URI (same one `npm run dev` uses)
// - this is an integration helper, not a mock.
const crypto = require("node:crypto");
const cookieSignature = require("cookie-signature");
const env = require("../../config/env");
const { connectWeb } = require("../../db/connection");

const COOKIE_NAME = "twitchbotweb.sid";

async function createTestSession(user) {
  const db = await connectWeb();
  const sid = crypto.randomBytes(24).toString("hex");
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const expires = new Date(Date.now() + maxAge);
  const sessionData = {
    cookie: { originalMaxAge: maxAge, expires: expires.toISOString(), httpOnly: true, path: "/", sameSite: "lax" },
    user,
  };

  await db.collection("sessions").updateOne(
    { _id: sid },
    { $set: { _id: sid, expires, session: JSON.stringify(sessionData) } },
    { upsert: true }
  );

  return {
    cookieName: COOKIE_NAME,
    cookieValue: "s:" + cookieSignature.sign(sid, env.sessionSecret),
    async destroy() {
      await db.collection("sessions").deleteOne({ _id: sid });
    },
  };
}

module.exports = { createTestSession, COOKIE_NAME };
