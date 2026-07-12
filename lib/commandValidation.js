// Validation for custom-command writes. Pure, so it is unit-testable without Mongo (same reason
// lib/settingsValidation.js exists - see CLAUDE.md, "Testing").
//
// These rules are not invented here: they mirror what the BOT already enforces when a moderator
// uses !addcommand / !settimer / !setpin in chat (TwitchBot/commands/CustomCommands.js). The web
// panel writes the same `custom_commands` collection the bot reads, so anything the panel lets
// through that the bot wouldn't is a way to create a command chat could never have created - and
// the bot would then execute it.

// The bot matches command names with /!([a-zа-я0-9]+)/ - Latin, Cyrillic, digits. No spaces, no
// punctuation, and crucially no regex metacharacters, since the name ends up in a matcher.
const NAME_PATTERN = /^[a-zа-я0-9]+$/;

const MAX_NAME_LENGTH = 30;
const MAX_RESULT_LENGTH = 480; // Twitch hard-caps a chat message at 500; leave room for counter substitution

// TwitchBot/commands/CustomCommands.js's setCommandTimer enforces this exact floor.
const MIN_TIMER_SECONDS = 60;
const MAX_TIMER_SECONDS = 24 * 60 * 60;

function normalizeName(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^!/, "");
}

/**
 * @returns {{ok: true, command: object} | {ok: false, error: string}}
 */
function parseCommand({ name, result, timerSeconds, pin }) {
  const command = normalizeName(name);

  if (!command) return { ok: false, error: "name_required" };
  if (command.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!NAME_PATTERN.test(command)) return { ok: false, error: "name_invalid" };

  const text = String(result ?? "").trim();
  if (!text) return { ok: false, error: "result_required" };
  if (text.length > MAX_RESULT_LENGTH) return { ok: false, error: "result_too_long" };

  const wantsPin = pin === true || pin === "on" || pin === "true";

  let timer = null;
  const rawTimer = String(timerSeconds ?? "").trim();
  if (rawTimer && rawTimer !== "off") {
    const seconds = parseInt(rawTimer, 10);
    if (!Number.isFinite(seconds)) return { ok: false, error: "timer_invalid" };
    if (seconds < MIN_TIMER_SECONDS) return { ok: false, error: "timer_too_short" };
    if (seconds > MAX_TIMER_SECONDS) return { ok: false, error: "timer_too_long" };
    timer = seconds * 1000; // the bot stores the timer in MILLISECONDS
  }

  // A timer and auto-pin cannot coexist: pin fires on every auto-post, and Twitch allows only one
  // active pinned message per channel at a time. The bot refuses this combination in chat, so the
  // panel must refuse it too - otherwise the website becomes a way to create a state the bot
  // considers illegal and would then act on.
  if (timer && wantsPin) return { ok: false, error: "timer_and_pin" };

  return { ok: true, command: { command, result: text, timer, pin: wantsPin } };
}

module.exports = {
  parseCommand,
  normalizeName,
  NAME_PATTERN,
  MAX_NAME_LENGTH,
  MAX_RESULT_LENGTH,
  MIN_TIMER_SECONDS,
  MAX_TIMER_SECONDS,
};
