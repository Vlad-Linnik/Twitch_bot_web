// Hand-maintained, mirrors the behavior implemented in TwitchBot/games/*.js.
module.exports = [
  {
    name: "Mute Duel",
    trigger: "!muteduel [@user] [seconds]",
    description:
      "Challenge chat or a specific user to a dice-roll duel. The loser is timed out - default 300s, minimum 300s, maximum 2 weeks. Use !muteaccept to accept a pending challenge.",
  },
  {
    name: "Dota 2 Item Advisor",
    trigger: "!совет",
    description: "Get a random (deliberately impractical) Dota 2 item suggestion.",
  },
];