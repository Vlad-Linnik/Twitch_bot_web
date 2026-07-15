// One-off CLI: register a Channels doc (and implicitly allow the settings
// page to seed ChannelConfig from the default template on first save).
// Usage: node scripts/seedChannel.js <channelLogin> <ownerTwitchUserId>
//
// Run this ONLY at the channel owner's request - first registration stamps
// Channels.consentedAt (see channelsRepo.upsertChannel), the consent record
// backing the /privacy page's claim that channels are added by owner request.
const { connect, getClient } = require("../db/connection");
const channelsRepo = require("../db/channelsRepo");

async function main() {
  const [channelLogin, ownerId] = process.argv.slice(2);
  if (!channelLogin || !ownerId) {
    console.error("Usage: node scripts/seedChannel.js <channelLogin> <ownerTwitchUserId>");
    process.exit(1);
  }

  await connect();
  const channel = await channelsRepo.upsertChannel({
    channelLogin,
    channelId: ownerId,
    ownerId,
  });
  console.log("Channel registered:", channel);
  await getClient().close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[seedChannel] Failed:", err);
  process.exit(1);
});
