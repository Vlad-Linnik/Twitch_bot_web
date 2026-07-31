// Validates a `returnTo` value carried through the OAuth login round-trip (routes/authRoutes.js)
// so a visitor lands back on the page that sent them to /auth/login. Must reject anything that
// isn't a same-origin relative path - `//evil.com` and `/\evil.com` are both browser-recognized
// ways to smuggle an absolute external URL into what looks like a path, and this value is never
// otherwise validated before being used in a redirect (an open-redirect vector if left unchecked).
const MAX_LENGTH = 400;

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}

module.exports = { sanitizeReturnTo };
