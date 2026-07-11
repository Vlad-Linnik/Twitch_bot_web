// Hand-maintained, kept in sync with TwitchBot/COMMANDS.md whenever a
// command is added/changed there. Deliberately not fetched cross-repo (see
// PLAN.md) - update both files together when the bot's command set changes.
module.exports = [
  {
    category: "Custom commands (mod-managed)",
    commands: [
      { signature: "!addcommand !name text", access: "mod", description: "Create a custom command, or edit its text if it already exists." },
      { signature: "!delcommand !name", access: "mod", description: "Delete a custom command." },
      { signature: "!settimer !name <seconds>|off", access: "mod", description: "Auto-post that command's text on an interval (minimum 60s); off disables it." },
      { signature: "!setpin !name on|off", access: "mod", description: "Toggle auto-pin for that command's sends." },
      { signature: "!customcommands", access: "all", description: "List all custom command names for the channel." },
      { signature: "!name", access: "all (mod-only if pinned)", description: "Trigger a custom command." },
    ],
  },
  {
    category: "Counters",
    commands: [
      { signature: "!addcounter #name [mod]", access: "mod", description: "Create a counter starting at 0; add mod to restrict updates to mods." },
      { signature: "!delcounter #name", access: "mod", description: "Delete a counter." },
      { signature: "!counters", access: "mod", description: "List all counter names." },
      { signature: "#name / #name + N / #name - N", access: "all (or mod/exception-listed)", description: "Increment/decrement a counter." },
      { signature: "!addexception username", access: "mod", description: "Grant a user rights to update mod-restricted counters." },
      { signature: "!remexception username", access: "mod", description: "Revoke that right." },
    ],
  },
  {
    category: "Chat stats",
    commands: [
      { signature: "!topchatters [day|week|month|all]", access: "all", description: "Top chatters leaderboard for the period." },
      { signature: "!topsmiles [period]", access: "all", description: "Most-used emotes for the period." },
      { signature: "!countword <word>", access: "all", description: "How many times a word was said today." },
      { signature: "!countmsg [period]", access: "all", description: "Your message count and rank for the period." },
      { signature: "!countunique [period]", access: "all", description: "Count of unique chatters for the period." },
      { signature: "!botinfo", access: "mod", description: "Bot uptime and DB stats summary." },
    ],
  },
  {
    category: "Moderation",
    commands: [
      { signature: "!addword <word>", access: "mod", description: "Track a word for word-count stats." },
      { signature: "!remword <word>", access: "mod", description: "Stop tracking a word." },
      { signature: "!update7tv", access: "mod", description: "Re-sync the channel's 7TV emote set into the tracked-word whitelist." },
    ],
  },
  {
    category: "Mini-games",
    commands: [
      { signature: "!muteduel [@user] [seconds]", access: "all", description: "Challenge chat or a user to a dice-roll duel; loser gets timed out." },
      { signature: "!muteaccept", access: "all", description: "Accept a pending mute duel." },
      { signature: "!совет", access: "all", description: "Get a random Dota 2 item suggestion." },
    ],
  },
];