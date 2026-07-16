// Validation for the /request-bot form (routes/requestBot.js), extracted here so it's
// unit-testable - same convention as lib/commandValidation.js / lib/settingsValidation.js.
const MESSAGE_MAX_LENGTH = 500;

// body is the raw POST body. Returns { ok: true, message } (message trimmed, possibly "")
// or { ok: false, error }. The mod-rights checkbox is required in the markup too, but a
// hand-crafted POST must not be able to skip the acknowledgement - it's the closest thing
// the request has to "I understand the bot needs moderator rights".
function parseRequestForm(body = {}) {
  if (body.modAcknowledged !== "on") {
    return { ok: false, error: "mod_ack_required" };
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > MESSAGE_MAX_LENGTH) {
    return { ok: false, error: "message_too_long" };
  }

  return { ok: true, message };
}

module.exports = { parseRequestForm, MESSAGE_MAX_LENGTH };
