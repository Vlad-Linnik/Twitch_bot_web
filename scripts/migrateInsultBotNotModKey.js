// One-off migration: responses.insultBotNotMod -> responses.insufficientPermissions
// (the field was renamed and generalized - see ../CLAUDE.md's cross-repo note and
// TwitchBot/shared/botPermission.js). For every ChannelConfig doc that still has a
// non-empty insultBotNotMod value and no insufficientPermissions override yet, copies
// it over; then unsets the old field from every doc regardless. Safe to re-run.
// Usage: node scripts/migrateInsultBotNotModKey.js
// Delete this file once it's been run against production (matches the project's
// existing one-time-migration convention - see migrateChannelConfigs.js/migrateChannelIds.js,
// both already deleted from the TwitchBot repo after their runs).
const { connect, getClient } = require("../db/connection");

async function main() {
  const db = await connect();
  const col = db.collection("ChannelConfig");

  const carried = await col.updateMany(
    {
      "responses.insultBotNotMod": { $exists: true, $nin: ["", null] },
      $or: [{ "responses.insufficientPermissions": { $exists: false } }, { "responses.insufficientPermissions": "" }],
    },
    [{ $set: { "responses.insufficientPermissions": "$responses.insultBotNotMod" } }]
  );
  console.log(`Carried over insultBotNotMod -> insufficientPermissions on ${carried.modifiedCount} doc(s).`);

  const unset = await col.updateMany(
    { "responses.insultBotNotMod": { $exists: true } },
    { $unset: { "responses.insultBotNotMod": "" } }
  );
  console.log(`Removed the old insultBotNotMod field from ${unset.modifiedCount} doc(s).`);

  await getClient().close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrateInsultBotNotModKey] Failed:", err);
  process.exit(1);
});
