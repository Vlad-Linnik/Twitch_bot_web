// Computes which top-level ChannelConfig fields actually changed between a save's "before"
// and "after" snapshots, for the settings-change audit log (db/settingsChangeLogRepo.js).
// `commands` is diffed one level deeper (per command key) since it's the field edited most
// narrowly and most often - a single "commands changed" entry would tell an owner nothing
// about which command a moderator actually touched.
const TRACKED_FIELDS = ["bannedWords", "spamSignatures", "spamBanReason", "sevenTv", "responses"];

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffConfig(before, after) {
  const changes = [];

  for (const field of TRACKED_FIELDS) {
    if (!isEqual(before?.[field], after?.[field])) {
      changes.push({ field, before: before?.[field] ?? null, after: after?.[field] ?? null });
    }
  }

  const commandNames = new Set([
    ...Object.keys(before?.commands || {}),
    ...Object.keys(after?.commands || {}),
  ]);
  for (const name of commandNames) {
    const beforeCmd = before?.commands?.[name];
    const afterCmd = after?.commands?.[name];
    if (!isEqual(beforeCmd, afterCmd)) {
      changes.push({ field: `commands.${name}`, before: beforeCmd ?? null, after: afterCmd ?? null });
    }
  }

  return changes;
}

module.exports = { diffConfig };
