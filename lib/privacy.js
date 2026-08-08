// Per-user profile privacy flags, resolved from a UserPreferences doc (or the absence of one).
// Pure - extracted from routes/userDashboard.js so the defaults are unit-testable, following
// the lib/settingsValidation.js pattern.
//
// Defaults are deliberate product decisions, not accidents:
//   - hideMessageVolume / hideChatActivity default to TRUE: the message-volume chart and the
//     activity calendar are hidden for EVERY user until that user opts in to showing them.
//   - hideWordCloud / hideMentions default to FALSE: unlike the two above, these panels have
//     always rendered unconditionally, so defaulting them hidden would silently blank a panel
//     every existing user is used to seeing the moment this shipped.
//   - hideProfile defaults to FALSE, and when a user turns it on the whole /:channel/user/:name
//     page becomes a stub for everyone - channel owner, moderators and admins included. The
//     profile owner sees the same stub but with the privacy-settings block, so they can undo it.
// A user with no UserPreferences doc at all therefore gets {true, true, false, false, false}.
//
// hideMessageVolume/hideChatActivity/hideWordCloud/hideMentions are edited directly on the
// profile page itself (views/partials/panelToggle.ejs, routes/userDashboard.js's panels.json),
// not on /settings - hideProfile is the only flag still edited there, since it hides the whole
// page rather than one panel on it.
function resolvePrivacy(prefs) {
  return {
    hideMessageVolume: prefs?.hideMessageVolume ?? true,
    hideChatActivity: prefs?.hideChatActivity ?? true,
    hideWordCloud: prefs?.hideWordCloud ?? false,
    hideMentions: prefs?.hideMentions ?? false,
    hideProfile: prefs?.hideProfile ?? false,
  };
}

module.exports = { resolvePrivacy };
