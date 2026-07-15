// Per-user profile privacy flags, resolved from a UserPreferences doc (or the absence of one).
// Pure - extracted from routes/userDashboard.js so the defaults are unit-testable, following
// the lib/settingsValidation.js pattern.
//
// Defaults are deliberate product decisions, not accidents:
//   - hideMessageVolume / hideChatActivity default to TRUE: the message-volume chart and the
//     activity calendar are hidden for EVERY user until that user opts in to showing them.
//   - hideProfile defaults to FALSE, and when a user turns it on the whole /:channel/user/:name
//     page becomes a stub for everyone - channel owner, moderators and admins included. The
//     profile owner sees the same stub but with the privacy-settings block, so they can undo it.
// A user with no UserPreferences doc at all therefore gets {true, true, false}.
function resolvePrivacy(prefs) {
  return {
    hideMessageVolume: prefs?.hideMessageVolume ?? true,
    hideChatActivity: prefs?.hideChatActivity ?? true,
    hideProfile: prefs?.hideProfile ?? false,
  };
}

module.exports = { resolvePrivacy };
