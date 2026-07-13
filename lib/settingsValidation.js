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

// Cooldowns are edited in whole seconds (the bot stores milliseconds); an
// unparseable or out-of-range submission returns null, meaning "keep the
// existing value" rather than guessing.
const MAX_COOLDOWN_SECONDS = 86400;
function parseCooldownSeconds(value) {
  const n = parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COOLDOWN_SECONDS) return null;
  return n;
}

// customCommandTimer.minMessagesBetween - how many ordinary chat messages must
// pass between two custom-command auto-posts. Same null-means-keep contract.
const MAX_MIN_MESSAGES = 1000;
function parseMinMessages(value) {
  const n = parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MIN_MESSAGES) return null;
  return n;
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
    commands[name] = { ...existingCmd };

    // An unchecked checkbox submits nothing, which is indistinguishable from the toggle not
    // being on the form at all - so every rendered toggle ships a `.present` marker, and only
    // marked commands get their enabled flag updated. Without this, any command whose toggle
    // lives on another page (insult - the Banned Words page) would be silently disabled by
    // every save of this form.
    if (existingCmd.enabled !== undefined && body[`commands.${name}.present`] === "1") {
      commands[name].enabled = body[`commands.${name}.enabled`] === "on";
    }

    // Only commands that already have a signature expose an editable field for
    // it in the form - never let a blank submission wipe an existing signature,
    // since that would break the bot's trigger matching for that command.
    // remSignature (paired remove-command, e.g. !remexception) and acceptSignature
    // (!muteaccept) follow the same blank-keeps rule.
    for (const field of ["signature", "remSignature", "acceptSignature"]) {
      if (existingCmd[field] !== undefined) {
        const submittedWord = sanitizeSignatureWord(body[`commands.${name}.${field}`]);
        if (submittedWord) commands[name][field] = `!${submittedWord}`;
      }
    }

    // Cooldowns are edited in seconds on the form, stored in ms (the bot's unit).
    if (existingCmd.cooldownMs !== undefined) {
      const seconds = parseCooldownSeconds(body[`commands.${name}.cooldownSeconds`]);
      if (seconds !== null) commands[name].cooldownMs = seconds * 1000;
    }

    if (existingCmd.minMessagesBetween !== undefined) {
      const minMessages = parseMinMessages(body[`commands.${name}.minMessagesBetween`]);
      if (minMessages !== null) commands[name].minMessagesBetween = minMessages;
    }
  }

  // Settings are now saved from several pages (main settings + the custom-commands
  // and counters sub-pages), each submitting only the fields it renders. A field
  // absent from the body means "not on that form" and must carry over unchanged;
  // a rendered text input/textarea always submits (possibly as ""), so deliberate
  // clearing still works.
  return {
    bannedWords: existing.bannedWords,
    spamSignatures: existing.spamSignatures,
    // Edited on the spam-signatures sub-page, carried over unchanged here.
    spamBanReason: existing.spamBanReason ?? "",
    sevenTv: {
      emoteSetUrl: body.emoteSetUrl !== undefined
        ? (body.emoteSetUrl || "").trim().slice(0, MAX_STRING_LEN)
        : (existing.sevenTv?.emoteSetUrl ?? ""),
    },
    commands,
    responses: {
      busy: body.busyResponses !== undefined
        ? sanitizeStringList((body.busyResponses || "").split("\n"))
        : (existing.responses?.busy ?? []),
      yesNo: body.yesNoResponses !== undefined
        ? sanitizeStringList((body.yesNoResponses || "").split("\n"))
        : (existing.responses?.yesNo ?? []),
      // System parameters, not user-editable on the site anymore - preserved as stored.
      insultModExempt: existing.responses?.insultModExempt ?? [],
      insufficientPermissions: existing.responses?.insufficientPermissions ?? "",
    },
  };
}

module.exports = {
  MAX_LIST_ITEMS,
  sanitizeStringList,
  sanitizeWord,
  sanitizeSignatureWord,
  parseCooldownSeconds,
  parseMinMessages,
  isValidHttpUrl,
  parseSubmittedConfig,
};
