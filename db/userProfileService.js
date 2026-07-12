// "How should this user be DISPLAYED?" - one owner for one question.
//
// This is a composition over two repos, not a repo itself: it has no collection of its own. It
// exists because the answer needs both of them (cached Twitch profile + the user's own overrides),
// and every caller that needed the answer was assembling it by hand.
//
// WHAT WENT WRONG WITHOUT IT
// --------------------------
// The colour policy - "their custom override if they set one, otherwise their real Twitch chat
// colour" - was written out longhand in middleware/navMenu.js and again in routes/about.js, while
// routes/userDashboard.js fetched the profile but skipped the override entirely. So a user who
// picked a custom colour on /settings saw it in the nav bar and on /about, and their raw Twitch
// colour on their own profile page. That is not a graph metric complaining about "cohesion"; it is
// a user-visible inconsistency, and it is exactly the bug a duplicated policy produces.
//
// The rule now lives here, once. Callers ask for a display profile and render it.
const profileCacheRepo = require("./profileCacheRepo");
const userPreferencesRepo = require("./userPreferencesRepo");

/**
 * The display-colour policy. Pure, so it can be unit-tested without Mongo or Twitch.
 *
 * Order matters: a custom colour only wins when the user has actually opted into it
 * (chatColorMode === "custom") AND set one. Someone who switches back to "twitch" mode must fall
 * back to their real chat colour, not keep a stale custom value.
 *
 * @param {object|null} prefs   - UserPreferences doc
 * @param {object|null} profile - TwitchProfileCache doc
 * @returns {string|null} a CSS colour, or null when nothing is known (render undecorated)
 */
function resolveDisplayColor(prefs, profile) {
  if (prefs?.chatColorMode === "custom" && prefs.customChatColor) return prefs.customChatColor;
  return profile?.chatColor || null;
}

/**
 * Everything needed to render a user's name and face: their avatar and the colour to draw their
 * name in.
 *
 * Fails soft. A profile lookup can hit Twitch (profileCacheRepo refreshes anything older than 7
 * days), and no page should 500 because a colour lookup timed out - callers get nulls and render
 * the user plainly.
 *
 * @param {string} userId - numeric Twitch user ID
 * @returns {Promise<{userId: string, avatarUrl: string|null, color: string|null}>}
 */
async function getDisplayProfile(userId) {
  if (!userId) return { userId, avatarUrl: null, color: null };

  const [profile, prefs] = await Promise.all([
    profileCacheRepo.getOrFetchProfile(userId).catch((err) => {
      console.error(`[userProfileService] profile lookup failed for ${userId}:`, err.message);
      return null;
    }),
    userPreferencesRepo.getPreferences(userId).catch((err) => {
      console.error(`[userProfileService] preferences lookup failed for ${userId}:`, err.message);
      return null;
    }),
  ]);

  return {
    userId,
    avatarUrl: profile?.avatarUrl || null,
    color: resolveDisplayColor(prefs, profile),
  };
}

module.exports = { getDisplayProfile, resolveDisplayColor };
