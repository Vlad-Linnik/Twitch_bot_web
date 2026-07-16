// Self-rescheduling periodic reconciliation of ModsList against Twitch's canonical Get
// Moderators, for every channel owner who has ever logged in (their refresh_token persisted
// by routes/authRoutes.js in db/ownerTokensRepo.js). Same resilience style as
// profileCacheScheduler.js / TwitchBot/twitch/TokenManager.js: one owner's failure (revoked
// consent, expired token) never stops the sweep for the rest, and a failed sweep doesn't
// cancel future ones.
const oauthClient = require("./oauthClient");
const { getModerators } = require("./channelModerators");
const ownerTokensRepo = require("../db/ownerTokensRepo");
const modsRepo = require("../db/modsRepo");

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

async function syncOwner(owner) {
  try {
    const refreshed = await oauthClient.refreshAccessToken(owner.refreshToken);
    // Save the rotated refresh_token before doing anything else - Twitch invalidates the
    // old one on every refresh, so losing this write would strand the owner's sync.
    await ownerTokensRepo.saveRefreshToken(owner.channelId, owner.ownerId, refreshed.refresh_token);

    const moderators = await getModerators(refreshed.access_token, owner.channelId);
    await modsRepo.setModerators(owner.channelId, moderators.map((m) => m.userId));
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    if (status === 400 || status === 401) {
      // Refresh token revoked/invalid (owner disconnected the app, etc.) - stop tracking
      // them until their next login re-saves a fresh one.
      await ownerTokensRepo.remove(owner.channelId);
      console.warn(`[moderatorSyncScheduler] Dropped owner token for channel ${owner.channelId}: ${detail}`);
      return;
    }
    console.error(`[moderatorSyncScheduler] Sync failed for channel ${owner.channelId}:`, detail);
  }
}

async function runSync() {
  const owners = await ownerTokensRepo.listAll();
  for (const owner of owners) {
    await syncOwner(owner);
  }
}

function startModeratorSyncLoop() {
  runSync().catch((err) => console.error("[moderatorSyncScheduler] initial sync failed:", err.message));
  setInterval(() => {
    runSync().catch((err) => console.error("[moderatorSyncScheduler] sync failed:", err.message));
  }, SYNC_INTERVAL_MS);
}

module.exports = { startModeratorSyncLoop };
