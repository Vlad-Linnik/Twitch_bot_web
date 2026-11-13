// What the channel owner can take away from an individual moderator: the right to CHANGE one
// section of the channel's management. Viewing is never affected - a moderator sees every page of
// tiers 0-2 whatever this says; only the mutating routes ask (middleware/permissions.js's
// requireSectionEditAccess).
//
// Stored per moderator in ModPermissionOverrides (web db, db/modPermissionOverridesRepo.js) as a
// list of DENIED keys. No row, or an empty list, means "may change everything": a new moderator
// starts unrestricted and the owner narrows by hand, so the row only has to exist to record a
// denial.
//
// This list is the single source for the middleware, the moderators page and the tests. Removing a
// key is safe: a stored denial for a key that no longer exists is ignored on read.
const MODERATOR_SECTIONS = [
  // Everything on the bot's settings page that is not one of the sections below.
  { key: "settings" },
  // Custom commands, their timers and the command settings page; variables.
  { key: "commands" },
  // Banned words, spam signatures, long bans.
  { key: "chatModeration" },
  // Every write on the Бюро амнистии desk: decisions, chat votes, the AI summaries, the Bureau's
  // own settings page.
  { key: "bureau" },
  // Comment moderation in every channel section (delete, restrict, lift a restriction) and the
  // cards of the channel sections themselves (create, edit, delete).
  { key: "discussions" },
].map((s) => ({
  ...s,
  labelKey: `moderatorPermissions.sections.${s.key}.label`,
  hintKey: `moderatorPermissions.sections.${s.key}.hint`,
}));

const SECTION_KEYS = MODERATOR_SECTIONS.map((s) => s.key);
const SECTION_KEY_SET = new Set(SECTION_KEYS);

// Rows written before the per-section split carry one boolean, `canEditSettings: false`, which
// closed exactly these four - comment moderation was never behind it. Read, never rewritten: the
// next save of that moderator writes `deny` and drops the old field.
const LEGACY_DENIED = ["settings", "commands", "chatModeration", "bureau"];

function isSectionKey(key) {
  return typeof key === "string" && SECTION_KEY_SET.has(key);
}

// The set of section keys a ModPermissionOverrides row denies. `deny` wins over the legacy flag
// whenever it is present at all (even empty), so a row saved under the new shape is never
// reinterpreted.
function deniedSections(override) {
  if (!override) return new Set();
  if (Array.isArray(override.deny)) return new Set(override.deny.filter(isSectionKey));
  if (override.canEditSettings === false) return new Set(LEGACY_DENIED);
  return new Set();
}

// The rule itself, for one already-known permission level (0 admin, 1 owner, 2 moderator, 3 the
// rest - middleware/permissions.js). An unknown key is a programming error, not a denial.
function canEditSection(level, override, key) {
  if (!isSectionKey(key)) throw new Error(`moderatorSections: unknown section ${key}`);
  if (!Number.isInteger(level)) return false;
  if (level <= 1) return true;
  if (level !== 2) return false;
  return !deniedSections(override).has(key);
}

// { settings: true, commands: false, ... } - what the moderators page draws per row.
function allowedMap(override) {
  const denied = deniedSections(override);
  return Object.fromEntries(SECTION_KEYS.map((key) => [key, !denied.has(key)]));
}

// The moderators form: one checkbox per moderator and section, `allow.<userId>.<section>` = "on"
// when the owner lets that moderator change that section, plus a `mod` field per row the form
// actually rendered. Only those rows are touched - a moderator added after the page was loaded
// has no checkboxes in it, and reading their absence as "every box unchecked" would strip them of
// everything. Ids outside `moderatorIds` (no longer a moderator, or forged) are dropped, as is any
// field naming an unknown section.
//
// Returns Map<userId, string[] denied keys in SECTION_KEYS order>.
function parsePermissionsForm(body, moderatorIds) {
  const known = new Set((moderatorIds || []).map(String));
  const rendered = [].concat(body?.mod ?? []).map(String).filter((id) => known.has(id));

  const result = new Map();
  for (const id of new Set(rendered)) {
    const deny = SECTION_KEYS.filter((key) => body[`allow.${id}.${key}`] !== "on");
    result.set(id, deny);
  }
  return result;
}

// [{ key, before, after }] for every section whose "may change" flipped between two override rows
// (or a row and a parsed deny list - anything deniedSections accepts).
function diffSections(beforeOverride, afterOverride) {
  const before = allowedMap(beforeOverride);
  const after = allowedMap(afterOverride);
  return SECTION_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    before: before[key],
    after: after[key],
  }));
}

// Which section owns a ChannelConfig field. Every settings form posts through the same
// parseSubmittedConfig (lib/settingsValidation.js), which honours ANY field present in the body -
// the pages differ only in which fields they render. So the route's own gate is not enough: a
// moderator allowed `commands` could post the Bureau's fields to the custom-commands page.
// restrictConfigToSections puts every field of a denied section back the way it was.
// Command keys are the bot's (config/channelSettings.js); a key not listed is general settings.
const COMMAND_SECTIONS = {
  commands: [
    "customCommandTimer", "addcommand", "settimer", "setpin", "setannounce", "delcommand",
    "varUpdate", "addvar", "delvar", "vars", "exception",
  ],
  chatModeration: ["insult", "longban", "cancellongban", "longbans"],
};
const FIELD_SECTIONS = {
  unbanBureau: "bureau",
  bannedWords: "chatModeration",
  spamSignatures: "chatModeration",
  spamBanReason: "chatModeration",
};
const COMMAND_SECTION_OF = new Map(
  Object.entries(COMMAND_SECTIONS).flatMap(([key, names]) => names.map((name) => [name, key]))
);

function configFieldSection(field, commandName) {
  if (field === "commands") return COMMAND_SECTION_OF.get(commandName) || "settings";
  return FIELD_SECTIONS[field] || "settings";
}

// `parsed` with every field whose section `canEdit(key)` refuses copied back from `existing`.
// Returns a new object; neither argument is modified.
function restrictConfigToSections(existing, parsed, canEdit) {
  const result = { ...parsed };
  for (const field of new Set([...Object.keys(existing || {}), ...Object.keys(parsed || {})])) {
    if (field === "commands") continue;
    if (canEdit(configFieldSection(field))) continue;
    if (existing && field in existing) result[field] = existing[field];
    else delete result[field];
  }
  if (parsed?.commands || existing?.commands) {
    const commands = { ...(parsed?.commands || {}) };
    for (const name of new Set([...Object.keys(existing?.commands || {}), ...Object.keys(commands)])) {
      if (canEdit(configFieldSection("commands", name))) continue;
      if (existing?.commands && name in existing.commands) commands[name] = existing.commands[name];
      else delete commands[name];
    }
    result.commands = commands;
  }
  return result;
}

// SettingsChangeLog targets for these changes: `moderator-permission:<userId>:<section>`, one row
// per section so autosave coalescing (db/settingsChangeLogRepo.js) only ever merges toggles of the
// same box. Rows from before the split have no section: `moderator-permission:<userId>`.
const TARGET_PREFIX = "moderator-permission:";

function permissionTarget(userId, key) {
  return `${TARGET_PREFIX}${userId}:${key}`;
}

function parsePermissionTarget(target) {
  if (typeof target !== "string" || !target.startsWith(TARGET_PREFIX)) return null;
  const rest = target.slice(TARGET_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon === -1) return { userId: rest, section: null };
  // Returned as written even if the section has since been removed - the reader decides how to
  // name it.
  return { userId: rest.slice(0, colon), section: rest.slice(colon + 1) };
}

module.exports = {
  MODERATOR_SECTIONS,
  SECTION_KEYS,
  LEGACY_DENIED,
  isSectionKey,
  deniedSections,
  canEditSection,
  allowedMap,
  parsePermissionsForm,
  diffSections,
  configFieldSection,
  restrictConfigToSections,
  permissionTarget,
  parsePermissionTarget,
};
