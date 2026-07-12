const MAX_LIST_ITEMS = 200;
const MAX_STRING_LEN = 500;
const MAX_SIGNATURE_LEN = 30;

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_STRING_LEN))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function sanitizeWord(value) {
  return (value || "").toString().trim().slice(0, MAX_STRING_LEN);
}

// Signatures are edited as a bare word (the leading "!" is a static prefix in
// the form, not part of the input) and matched literally at the start of a
// chat message by the bot (see TwitchBot/config/channelSettings.js's
// getCommandSignatureRegex) - a signature with embedded whitespace could
// never match a real invocation, so only the first token survives, and the
// "!" gets re-added by the caller rather than trusted from the submission.
function sanitizeSignatureWord(value) {
  return (value || "")
    .toString()
    .trim()
    .replace(/^!+/, "")
    .split(/\s+/)[0]
    .slice(0, MAX_SIGNATURE_LEN);
}

// The bot fetches this URL server-side to pull 7TV emotes, so reject anything
// that isn't a well-formed http(s) URL rather than persisting it unchecked.
function isValidHttpUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Parses the submitted form into the same shape as config/defaultChannelConfig.json,
// dropping anything that isn't an expected field (never trust the request body shape).
// bannedWords/spamSignatures aren't submitted from this form anymore - they're
// managed on their own sub-pages (routes/settings.js's banned-words/spam-signatures
// routes) - so they're carried over unchanged from the existing config instead
// of being parsed from the body (an absent field here must never wipe them).
function parseSubmittedConfig(body, existing) {
  const commands = {};
  for (const [name, existingCmd] of Object.entries(existing.commands || {})) {
    commands[name] = {
      ...existingCmd,
      enabled: body[`commands.${name}.enabled`] === "on",
    };
    // Only commands that already have a signature expose an editable field for
    // it in the form - never let a blank submission wipe an existing signature,
    // since that would break the bot's trigger matching for that command.
    if (existingCmd.signature !== undefined) {
      const submittedWord = sanitizeSignatureWord(body[`commands.${name}.signature`]);
      if (submittedWord) commands[name].signature = `!${submittedWord}`;
    }
  }

  return {
    bannedWords: existing.bannedWords,
    spamSignatures: existing.spamSignatures,
    sevenTv: {
      emoteSetUrl: (body.emoteSetUrl || "").trim().slice(0, MAX_STRING_LEN),
    },
    commands,
    responses: {
      busy: sanitizeStringList((body.busyResponses || "").split("\n")),
      yesNo: sanitizeStringList((body.yesNoResponses || "").split("\n")),
      insultModExempt: sanitizeStringList((body.insultModExempt || "").split("\n")),
      insufficientPermissions: sanitizeWord(body.insufficientPermissions),
    },
  };
}

module.exports = {
  MAX_LIST_ITEMS,
  sanitizeStringList,
  sanitizeWord,
  sanitizeSignatureWord,
  isValidHttpUrl,
  parseSubmittedConfig,
};
