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

// Per-category text overrides: a command can say something different depending on the stream's
// current Twitch category (game_name), falling back to the plain `result` for everything else -
// see TwitchBot/twitch/streamStatus.js's category tracking and CustomCommands.js's
// resolveCommandText. Web-panel-only, same as announceColor - there's no chat command for it.
const MAX_CATEGORY_LENGTH = 50;
const MAX_CATEGORY_OVERRIDES = 5;

// TwitchBot/commands/CustomCommands.js's setCommandTimer enforces this exact floor.
const MIN_TIMER_SECONDS = 60;
const MAX_TIMER_SECONDS = 24 * 60 * 60;

// Alternate trigger words for a command (e.g. !hi as a synonym for !hello) - web-panel-only, same
// as categoryTexts/modOnly, matched by TwitchBot/commands/CustomCommands.js's exex_custom_command
// with the same startsWith-prefix logic as the command's own name. Capped low: this is meant for
// a couple of obvious spelling variants, not a second command list.
const MAX_ALIASES = 5;

// Twitch's Send Chat Announcement color enum (TwitchBot/twitch/TwitchChatAPI.js's
// sendAnnouncement). Anything else falls back to "primary" rather than rejecting the save -
// same "never trust the request body shape" spirit as the rest of this module.
const ANNOUNCEMENT_COLORS = ["blue", "green", "orange", "purple", "primary"];

function normalizeName(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^!/, "");
}

// `raw` is the zipped [{category, result}, ...] from the form's fixed rows (routes/customCommands.js
// zips the parallel categoryName[]/categoryResult[] arrays before calling parseCommand) - a row
// left entirely blank (an unused row in the fixed set) is silently dropped, but a row with only
// one side filled in is a mistake worth rejecting rather than silently discarding half of it.
function parseCategoryTexts(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const categoryTexts = [];
  for (const row of rows) {
    const category = String(row?.category ?? "").trim();
    const text = String(row?.result ?? "").trim();
    if (!category && !text) continue;
    if (!category) return { ok: false, error: "category_required" };
    if (category.length > MAX_CATEGORY_LENGTH) return { ok: false, error: "category_too_long" };
    if (!text) return { ok: false, error: "category_result_required" };
    if (text.length > MAX_RESULT_LENGTH) return { ok: false, error: "category_result_too_long" };

    const key = category.toLowerCase();
    if (seen.has(key)) return { ok: false, error: "category_duplicate" };
    seen.add(key);
    categoryTexts.push({ category, result: text });
  }
  if (categoryTexts.length > MAX_CATEGORY_OVERRIDES) return { ok: false, error: "category_overrides_too_many" };
  return { ok: true, categoryTexts };
}

// `raw` is a single freeform string from the form (comma/whitespace-separated, e.g.
// "hi, hey privet") - split, normalize each piece the same way normalizeName does for the
// primary command name, and reject anything that wouldn't be a legal command name either
// (aliases are matched by the exact same startsWith-prefix logic, so they must obey the exact
// same character set).
function parseAliases(raw) {
  const pieces = String(raw || "")
    .split(/[,\s]+/)
    .map((a) => normalizeName(a))
    .filter(Boolean);
  const aliases = [];
  const seen = new Set();
  for (const alias of pieces) {
    if (alias.length > MAX_NAME_LENGTH) return { ok: false, error: "alias_too_long" };
    if (!NAME_PATTERN.test(alias)) return { ok: false, error: "alias_invalid" };
    if (seen.has(alias)) continue; // repeated in the same field - dedupe rather than reject
    seen.add(alias);
    aliases.push(alias);
  }
  if (aliases.length > MAX_ALIASES) return { ok: false, error: "aliases_too_many" };
  return { ok: true, aliases };
}

// A command's own name, or one of its aliases, must not collide with another command's name or
// alias in the same channel: TwitchBot/commands/CustomCommands.js's trigger lookup is a flat map
// keyed by whichever name/alias reaches it first, so two different commands claiming the same
// trigger would make dispatch non-deterministic (whichever one the bot's cache happened to build
// first would silently shadow the other). `others` is every OTHER command already saved in the
// channel - the route is responsible for excluding the command being edited from it.
//
// Returns which command owns the colliding trigger (`conflictsWith`) so the caller can tell the
// mod exactly what they collided with, instead of just "try something else".
function checkAliasConflicts(command, aliases, others) {
  const owner = new Map(); // trigger -> the command name that already claims it
  for (const other of others) {
    if (!owner.has(other.command)) owner.set(other.command, other.command);
    for (const alias of other.aliases || []) {
      if (!owner.has(alias)) owner.set(alias, other.command);
    }
  }
  if (owner.has(command)) return { ok: false, error: "name_conflict", conflictsWith: owner.get(command) };
  for (const alias of aliases) {
    if (owner.has(alias)) return { ok: false, error: "alias_conflict", conflictsWith: owner.get(alias) };
  }
  return { ok: true };
}

/**
 * @returns {{ok: true, command: object} | {ok: false, error: string}}
 */
function parseCommand({ name, result, timerSeconds, pin, announce, announceColor, enabled, categoryTexts, modOnly, aliases }) {
  const command = normalizeName(name);

  if (!command) return { ok: false, error: "name_required" };
  if (command.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
  if (!NAME_PATTERN.test(command)) return { ok: false, error: "name_invalid" };

  const text = String(result ?? "").trim();
  if (!text) return { ok: false, error: "result_required" };
  if (text.length > MAX_RESULT_LENGTH) return { ok: false, error: "result_too_long" };

  const wantsPin = pin === true || pin === "on" || pin === "true";
  const wantsAnnounce = announce === true || announce === "on" || announce === "true";
  // Unlike pin/announce, a brand-new command has no prior form state to default from, so an
  // absent checkbox here means "unchecked" only when the form actually rendered one (it always
  // does, pre-checked) - same true-only-on-"on" convention as pin/announce, not a hidden default.
  const wantsEnabled = enabled === true || enabled === "on" || enabled === "true";
  // Mirrors TwitchBot/commands/CustomCommands.js's exex_custom_command gate: modOnly is the only
  // flag that gates whether a manual `!name` trigger is accepted at all - `pin` sends for every
  // trigger and only pins the ones a mod sent, `announce` doesn't gate triggering either.
  const wantsModOnly = modOnly === true || modOnly === "on" || modOnly === "true";
  const color = ANNOUNCEMENT_COLORS.includes(announceColor) ? announceColor : "primary";

  const categoryResult = parseCategoryTexts(categoryTexts);
  if (!categoryResult.ok) return categoryResult;

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

  // Announce and pin cannot coexist either: an announcement is a self-contained Helix send with
  // no message ID to pin, mirroring the bot's own setCommandAnnounce/setCommandPin check.
  if (wantsAnnounce && wantsPin) return { ok: false, error: "announce_and_pin" };

  const aliasResult = parseAliases(aliases);
  if (!aliasResult.ok) return aliasResult;
  if (aliasResult.aliases.includes(command)) return { ok: false, error: "alias_matches_name" };

  return {
    ok: true,
    command: {
      command, result: text, timer, pin: wantsPin, announce: wantsAnnounce, announceColor: color,
      enabled: wantsEnabled, categoryTexts: categoryResult.categoryTexts, aliases: aliasResult.aliases,
    },
  };
}

module.exports = {
  parseCommand,
  checkAliasConflicts,
  normalizeName,
  NAME_PATTERN,
  MAX_NAME_LENGTH,
  MAX_RESULT_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_CATEGORY_OVERRIDES,
  MAX_ALIASES,
  MIN_TIMER_SECONDS,
  MAX_TIMER_SECONDS,
  ANNOUNCEMENT_COLORS,
};
